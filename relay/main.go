// htl-relay — a tiny, locked-down YouTube-only fetch relay for the FortiGate.
//
// The Worker forwards its YouTube requests here (over the cloudflared tunnel) so they
// egress from this box's residential IP. It is deliberately dumb: it fetches ONLY
// YouTube hosts, pins IPv4 (so a resolve and its IP-locked googlevideo URL share the
// same address), authenticates a shared secret, and caps concurrency so it can't
// saturate the home line. All resolve logic stays in the Worker.
package main

import (
	"bytes"
	"context"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

var secret = os.Getenv("RELAY_SECRET")

func envOr(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}

// IPv4-pinned transport: the googlevideo URL is locked to the IP that resolved it, so
// every hop (resolve + byte fetch) must leave over the same family. We force tcp4.
var client = &http.Client{
	Timeout: 60 * time.Second,
	Transport: &http.Transport{
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			return (&net.Dialer{Timeout: 15 * time.Second}).DialContext(ctx, "tcp4", addr)
		},
		ForceAttemptHTTP2:   true,
		MaxIdleConns:        32,
		IdleConnTimeout:     90 * time.Second,
		TLSHandshakeTimeout: 15 * time.Second,
	},
}

// The ONLY hosts this relay will ever fetch. This is the SSRF / open-proxy lock: even a
// leaked secret can't turn the home line into a general-purpose proxy.
func allowedHost(h string) bool {
	h = strings.ToLower(h)
	if i := strings.IndexByte(h, ':'); i >= 0 {
		h = h[:i]
	}
	return h == "youtubei.googleapis.com" || h == "www.youtube.com" || strings.HasSuffix(h, ".googlevideo.com")
}

var sem = make(chan struct{}, 6) // concurrency cap — protect the home upstream

// Token-bucket rate limit (defense-in-depth behind the shared secret + Cloudflare Access).
// Real relay volume is tiny — the R2 cache means it fires only on the ~1-3% cold-miss tail
// (tens/day) — so a generous cap never touches legit traffic; it only stops a leaked secret
// or a runaway Worker from pumping the home line continuously. Tunable via RELAY_RPM.
type rateBucket struct {
	mu     sync.Mutex
	tokens float64
	last   time.Time
	rate   float64 // tokens per second
	burst  float64
}

func (b *rateBucket) allow() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	now := time.Now()
	if b.last.IsZero() {
		b.last = now
	}
	b.tokens += now.Sub(b.last).Seconds() * b.rate
	if b.tokens > b.burst {
		b.tokens = b.burst
	}
	b.last = now
	if b.tokens >= 1 {
		b.tokens--
		return true
	}
	return false
}

func atoiOr(s string, d int) int {
	if n, err := strconv.Atoi(s); err == nil && n > 0 {
		return n
	}
	return d
}

// RELAY_RPM requests/minute (default 120 = 2/s); burst = a quarter-minute of headroom (min 10).
var rpm = atoiOr(os.Getenv("RELAY_RPM"), 120)
var limiter = func() *rateBucket {
	burst := float64(rpm) / 4.0
	if burst < 10 {
		burst = 10
	}
	// Start FULL (tokens == burst) so the first legit request isn't rejected on a cold start.
	return &rateBucket{rate: float64(rpm) / 60.0, burst: burst, tokens: burst}
}()

func handleFetch(w http.ResponseWriter, r *http.Request) {
	if secret == "" || r.Header.Get("X-Relay-Secret") != secret {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	if !limiter.allow() {
		http.Error(w, "rate limited", http.StatusTooManyRequests)
		return
	}
	target := r.Header.Get("X-Relay-Target")
	if target == "" {
		http.Error(w, "missing X-Relay-Target", http.StatusBadRequest)
		return
	}
	method := r.Header.Get("X-Relay-Method")
	if method == "" {
		method = "GET"
	}

	var body io.Reader
	if method != "GET" && method != "HEAD" {
		b, _ := io.ReadAll(io.LimitReader(r.Body, 1<<20)) // small player bodies; cap 1 MB
		body = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(r.Context(), method, target, body)
	if err != nil {
		http.Error(w, "bad target", http.StatusBadRequest)
		return
	}
	if req.URL.Scheme != "https" || !allowedHost(req.URL.Host) {
		http.Error(w, "host not allowed", http.StatusForbidden)
		return
	}
	// Forward request headers the Worker tagged with X-Fwd- (prefix stripped). Do NOT
	// forward Accept-Encoding so Go's transport handles gzip transparently and the Worker
	// always sees plain bytes.
	for k, vv := range r.Header {
		lk := strings.ToLower(k)
		if strings.HasPrefix(lk, "x-fwd-") && lk != "x-fwd-accept-encoding" {
			name := k[len("x-fwd-"):]
			for _, v := range vv {
				req.Header.Add(name, v)
			}
		}
	}

	sem <- struct{}{}
	defer func() { <-sem }()

	resp, err := client.Do(req)
	if err != nil {
		http.Error(w, "upstream error: "+err.Error(), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	for _, h := range []string{"Content-Type", "Content-Length", "Content-Range", "Accept-Ranges"} {
		if v := resp.Header.Get(h); v != "" {
			w.Header().Set(h, v)
		}
	}
	w.WriteHeader(resp.StatusCode)
	io.Copy(w, resp.Body)
}

func main() {
	if secret == "" {
		log.Fatal("RELAY_SECRET not set")
	}
	addr := envOr("RELAY_ADDR", "127.0.0.1:8088")
	http.HandleFunc("/fetch", handleFetch)
	http.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("ok\n")) })
	log.Printf("htl-relay on %s — youtube-only, ipv4-pinned, concurrency=%d, rpm=%d", addr, cap(sem), rpm)
	log.Fatal((&http.Server{Addr: addr, ReadHeaderTimeout: 10 * time.Second}).ListenAndServe())
}
