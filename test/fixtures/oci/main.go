package main
import ("net/http"; "log")
func main() { http.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) { w.Header().Set("Content-Type", "application/json"); w.Write([]byte(`{"status":"ok"}`)) }); log.Fatal(http.ListenAndServe(":8080", nil)) }
