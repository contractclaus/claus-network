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
 "sync"
 "syscall"
 "time"
)

type Check struct { Name string `json:"name"`; Status int `json:"status"`; Millis int64 `json:"latencyMs"`; OK bool `json:"ok"`; Error string `json:"error,omitempty"` }
type Observation struct { At time.Time `json:"observedAt"`; Checks []Check `json:"checks"`; Healthy bool `json:"healthy"` }
type State struct { sync.RWMutex; Current Observation; History []Observation }
var state State
var client = &http.Client{Timeout: 8*time.Second, CheckRedirect:func(_ *http.Request,_ []*http.Request)error{return http.ErrUseLastResponse}}
var targets = []struct{Name, URL string}{
 {"network-api","https://claus-network-api.vercel.app/health"},
 {"network-map","https://claus-network-api.vercel.app/v1/public/graph?view=projects&limit=100"},
 {"network-operations","https://claus-network-api.vercel.app/v1/public/operations"},
}

func observe(ctx context.Context) {
 value:=Observation{At:time.Now().UTC(),Healthy:true,Checks:make([]Check,len(targets))}
 var wg sync.WaitGroup
 for i,t:=range targets {wg.Add(1);go func(i int,name,url string){defer wg.Done();start:=time.Now();check:=Check{Name:name}
  req,err:=http.NewRequestWithContext(ctx,"GET",url,nil)
  if err==nil {req.Header.Set("Accept","application/json");var res *http.Response;res,err=client.Do(req);if err==nil {check.Status=res.StatusCode;body,readErr:=io.ReadAll(io.LimitReader(res.Body,2*1024*1024+1));res.Body.Close();if readErr!=nil {err=readErr} else if len(body)>2*1024*1024 {err=fmt.Errorf("response too large")} else {check.OK=res.StatusCode==200&&json.Valid(body)}}}
  check.Millis=time.Since(start).Milliseconds();if err!=nil {check.Error="observation unavailable"};value.Checks[i]=check
 }(i,t.Name,t.URL)};wg.Wait()
 for _,check:=range value.Checks {if !check.OK {value.Healthy=false}}
 state.Lock();state.Current=value;state.History=append(state.History,value);if len(state.History)>1440 {state.History=state.History[len(state.History)-1440:]};state.Unlock()
 log.Printf("network observation complete healthy=%v",value.Healthy)
}

func jsonResponse(w http.ResponseWriter,r *http.Request,v any){
 w.Header().Set("Content-Type","application/json");w.Header().Set("Cache-Control","no-store");w.Header().Set("X-Content-Type-Options","nosniff")
 if r.Method!="GET"&&r.Method!="HEAD" {w.WriteHeader(405);return};if r.Method=="HEAD" {return};json.NewEncoder(w).Encode(v)
}
func main(){
 ctx,cancel:=signal.NotifyContext(context.Background(),os.Interrupt,syscall.SIGTERM);defer cancel()
 go func(){observe(ctx);timer:=time.NewTicker(time.Minute);defer timer.Stop();for {select{case <-ctx.Done():return;case <-timer.C:observe(ctx)}}}()
 mux:=http.NewServeMux()
 mux.HandleFunc("/health",func(w http.ResponseWriter,r *http.Request){jsonResponse(w,r,map[string]any{"status":"ok","service":"Claus Network Watch","release":"1"})})
 mux.HandleFunc("/v1/status",func(w http.ResponseWriter,r *http.Request){state.RLock();value:=state.Current;state.RUnlock();jsonResponse(w,r,value)})
 mux.HandleFunc("/v1/history",func(w http.ResponseWriter,r *http.Request){state.RLock();value:=append([]Observation(nil),state.History...);state.RUnlock();jsonResponse(w,r,map[string]any{"observations":value,"retention":"last 24 hours while this process runs","scope":"three public endpoints, not all network functions"})})
 mux.HandleFunc("/",func(w http.ResponseWriter,r *http.Request){if r.URL.Path!="/"{http.NotFound(w,r);return};if r.Method!="GET"&&r.Method!="HEAD"{w.WriteHeader(405);return};w.Header().Set("Content-Type","text/html; charset=utf-8");w.Header().Set("Cache-Control","public,max-age=10");w.Header().Set("Content-Security-Policy","default-src 'none'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");if r.Method!="HEAD"{state.RLock();value:=state.Current;state.RUnlock();fmt.Fprintf(w,"<!doctype html><html lang=en><meta charset=utf-8><meta name=viewport content='width=device-width, initial-scale=1'><meta http-equiv=refresh content=60><title>Claus | Network Watch</title><style>body{margin:0;background:#df7848;color:#111;font:18px system-ui}main{max-width:900px;margin:8vh auto;padding:24px}h1{font-size:clamp(40px,8vw,80px);letter-spacing:-.05em}a{color:inherit}table{width:100%%;border-collapse:collapse}td,th{text-align:left;padding:14px 0;border-bottom:1px solid #1113}footer{margin-top:40px;font-size:14px}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style><main><a href='https://claus.si/Network'>Claus</a><h1>Network Watch</h1><p>Observed %s</p><table><tr><th>Endpoint<th>Status<th>Latency",value.At.Format(time.RFC3339));for _,c:=range value.Checks {status:="Unavailable";if c.OK{status="Responding"};fmt.Fprintf(w,"<tr><td>%s<td>%s<td>%d ms",c.Name,status,c.Millis)};fmt.Fprint(w,"</table><footer>Three public endpoint checks, refreshed every minute. This does not certify every feature.<p><a href='/v1/status'>Status JSON</a> · <a href='/v1/history'>History JSON</a></footer></main></html>")}})
 server:=&http.Server{Addr:":8080",Handler:mux,ReadHeaderTimeout:5*time.Second,ReadTimeout:10*time.Second,WriteTimeout:10*time.Second,IdleTimeout:30*time.Second,MaxHeaderBytes:16384}
 go func(){<-ctx.Done();shutdown,c:=context.WithTimeout(context.Background(),5*time.Second);defer c();server.Shutdown(shutdown)}()
 log.Println("Claus Network Watch :8080");if err:=server.ListenAndServe();err!=nil&&err!=http.ErrServerClosed{log.Fatal(err)}
}
