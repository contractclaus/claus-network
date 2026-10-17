package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"sync"
	"syscall"
	"time"
)

type Check struct {
	Name   string `json:"name"`
	Status int    `json:"status"`
	Millis int64  `json:"latencyMs"`
	OK     bool   `json:"ok"`
	Error  string `json:"error,omitempty"`
}
type Observation struct {
	At      time.Time `json:"observedAt"`
	Checks  []Check   `json:"checks"`
	Healthy bool      `json:"healthy"`
}
type HistoryPage struct {
	Observations []Observation `json:"observations"`
	NextBefore   string        `json:"nextBefore,omitempty"`
	Retention    string        `json:"retention"`
	Scope        string        `json:"scope"`
}
type State struct {
	sync.RWMutex
	Current                 Observation
	History                 []Observation
	StatusJSON, HistoryJSON []byte
}

var state State
var client = &http.Client{Timeout: 8 * time.Second, Transport: &http.Transport{Proxy: nil, MaxConnsPerHost: 4, MaxIdleConns: 6, IdleConnTimeout: 60 * time.Second, TLSHandshakeTimeout: 5 * time.Second, ResponseHeaderTimeout: 6 * time.Second}, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}
var targets = []struct{ Name, URL string }{
	{"network-api", "https://claus-network-api.vercel.app/health"},
	{"network-map", "https://claus-network-api.vercel.app/v1/public/graph?view=projects&limit=100"},
	{"network-operations", "https://claus-network-api.vercel.app/v1/public/operations"},
}

func historyPage(history []Observation, before time.Time, limit int) HistoryPage {
	end := len(history)
	for end > 0 && !before.IsZero() && !history[end-1].At.Before(before) {
		end--
	}
	start := end - limit
	if start < 0 {
		start = 0
	}
	page := HistoryPage{Observations: append([]Observation{}, history[start:end]...), Retention: "last 24 hours while this process runs", Scope: "three public endpoints, not all network functions"}
	if start > 0 {
		page.NextBefore = history[start].At.Format(time.RFC3339Nano)
	}
	return page
}
func observe(ctx context.Context) {
	value := Observation{At: time.Now().UTC(), Healthy: true, Checks: make([]Check, len(targets))}
	var wg sync.WaitGroup
	for i, t := range targets {
		wg.Add(1)
		go func(i int, name, url string) {
			defer wg.Done()
			start := time.Now()
			check := Check{Name: name}
			req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
			if err == nil {
				req.Header.Set("Accept", "application/json")
				var res *http.Response
				res, err = client.Do(req)
				if err == nil {
					check.Status = res.StatusCode
					body, readErr := io.ReadAll(io.LimitReader(res.Body, 2*1024*1024+1))
					res.Body.Close()
					if readErr != nil {
						err = readErr
					} else if len(body) > 2*1024*1024 {
						err = fmt.Errorf("response too large")
					} else {
						check.OK = res.StatusCode == 200 && json.Valid(body)
					}
				}
			}
			check.Millis = time.Since(start).Milliseconds()
			if err != nil {
				check.Error = "observation unavailable"
			}
			value.Checks[i] = check
		}(i, t.Name, t.URL)
	}
	wg.Wait()
	if ctx.Err() != nil {
		return
	}
	for _, check := range value.Checks {
		if !check.OK {
			value.Healthy = false
		}
	}
	state.Lock()
	state.Current = value
	state.History = append(state.History, value)
	if len(state.History) > 1440 {
		state.History = state.History[len(state.History)-1440:]
	}
	state.StatusJSON, _ = json.Marshal(value)
	state.HistoryJSON, _ = json.Marshal(historyPage(state.History, time.Time{}, 60))
	state.Unlock()
	log.Printf("network observation complete healthy=%v", value.Healthy)
}
func methodAllowed(w http.ResponseWriter, r *http.Request) bool {
	if r.Method == "GET" || r.Method == "HEAD" {
		return true
	}
	w.Header().Set("Allow", "GET, HEAD")
	w.WriteHeader(http.StatusMethodNotAllowed)
	return false
}
func jsonBytes(w http.ResponseWriter, r *http.Request, status int, data []byte, cache string) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Content-Length", strconv.Itoa(len(data)))
	w.Header().Set("Cache-Control", cache)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	if r.Method != "HEAD" {
		w.Write(data)
	}
}
func handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		if !methodAllowed(w, r) {
			return
		}
		state.RLock()
		ready := !state.Current.At.IsZero()
		state.RUnlock()
		if !ready {
			jsonBytes(w, r, 503, []byte(`{"status":"starting"}`), "no-store")
			return
		}
		jsonBytes(w, r, 200, []byte(`{"status":"ok","service":"Claus Network Watch","release":"2"}`), "no-store")
	})
	mux.HandleFunc("/v1/status", func(w http.ResponseWriter, r *http.Request) {
		if !methodAllowed(w, r) {
			return
		}
		state.RLock()
		data := state.StatusJSON
		state.RUnlock()
		if data == nil {
			jsonBytes(w, r, 503, []byte(`{"status":"starting","checks":[]}`), "no-store")
			return
		}
		jsonBytes(w, r, 200, data, "public, max-age=5")
	})
	mux.HandleFunc("/v1/history", func(w http.ResponseWriter, r *http.Request) {
		if !methodAllowed(w, r) {
			return
		}
		limit := 60
		before := time.Time{}
		q := r.URL.Query()
		if text := q.Get("limit"); text != "" {
			v, err := strconv.Atoi(text)
			if err != nil || v < 1 || v > 240 {
				http.Error(w, "limit must be between 1 and 240", 400)
				return
			}
			limit = v
		}
		if text := q.Get("before"); text != "" {
			v, err := time.Parse(time.RFC3339Nano, text)
			if err != nil {
				http.Error(w, "before must be an RFC3339 timestamp", 400)
				return
			}
			before = v
		}
		state.RLock()
		data := state.HistoryJSON
		if limit != 60 || !before.IsZero() {
			data, _ = json.Marshal(historyPage(state.History, before, limit))
		}
		state.RUnlock()
		if data == nil {
			jsonBytes(w, r, 503, []byte(`{"status":"starting","observations":[]}`), "no-store")
			return
		}
		jsonBytes(w, r, 200, data, "public, max-age=10")
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		if !methodAllowed(w, r) {
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "public,max-age=10")
		w.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'")
		state.RLock()
		value := state.Current
		state.RUnlock()
		if value.At.IsZero() {
			w.WriteHeader(503)
			if r.Method != "HEAD" {
				io.WriteString(w, "<!doctype html><title>Claus | Network Watch</title><p>Starting</p>")
			}
			return
		}
		if r.Method == "HEAD" {
			return
		}
		fmt.Fprintf(w, "<!doctype html><html lang=en><meta charset=utf-8><meta name=viewport content='width=device-width, initial-scale=1'><meta http-equiv=refresh content=60><title>Claus | Network Watch</title><style>body{margin:0;background:#df7848;color:#111;font:18px system-ui}main{max-width:900px;margin:8vh auto;padding:24px}h1{font-size:clamp(40px,8vw,80px);letter-spacing:-.05em}a{color:inherit}table{width:100%%;border-collapse:collapse}td,th{text-align:left;padding:14px 0;border-bottom:1px solid #1113}footer{margin-top:40px;font-size:14px}</style><main><a href='https://claus.si/Network'>Claus</a><h1>Network Watch</h1><p>Observed %s</p><table><tr><th>Endpoint<th>Status<th>Latency", value.At.Format(time.RFC3339))
		for _, c := range value.Checks {
			status := "Unavailable"
			if c.OK {
				status = "Responding"
			}
			fmt.Fprintf(w, "<tr><td>%s<td>%s<td>%d ms", c.Name, status, c.Millis)
		}
		io.WriteString(w, "</table><footer>Three public endpoint checks, refreshed every minute.<p><a href='/v1/status'>Status JSON</a> · <a href='/v1/history'>History JSON</a></footer></main></html>")
	})
	return mux
}
func main() {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	observe(ctx)
	if ctx.Err() != nil {
		return
	}
	go func() {
		timer := time.NewTicker(time.Minute)
		defer timer.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-timer.C:
				observe(ctx)
			}
		}
	}()
	server := &http.Server{Addr: ":8080", Handler: handler(), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 10 * time.Second, IdleTimeout: 30 * time.Second, MaxHeaderBytes: 16384}
	drained := make(chan struct{})
	go func() {
		<-ctx.Done()
		defer close(drained)
		shutdown, c := context.WithTimeout(context.Background(), 5*time.Second)
		defer c()
		if err := server.Shutdown(shutdown); err != nil {
			server.Close()
		}
	}()
	log.Println("Claus Network Watch :8080")
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Printf("server stopped: %v", err)
		cancel()
	}
	<-drained
}
