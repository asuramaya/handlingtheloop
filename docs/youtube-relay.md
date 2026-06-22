# Residential YouTube-fetch relay (FortiGate + cloudflared)

Built 2026-06-22. Solves the "every uncached song intermittently fails" problem: YouTube
bot-walls Cloudflare's datacenter egress (`LOGIN_REQUIRED` / `player 403`), but only
*intermittently* and *per-IP*. A residential IP isn't flagged. So cold loads the datacenter
can't get after retries are re-routed through a relay on a home FortiGate's residential line.

## Why this shape (see the memories for the full reasoning)

- A browser **can't** be the fetcher (CORS double-wall: can't call innertube, can't read
  googlevideo bytes — tainted). Only a non-browser process can. So the fetcher must be
  server-side. The relay is that, on hardware we own = zero marginal cost.
- The **R2 community cache** means the relay fires at most **once per track ever** (cold
  miss the datacenter also failed). After that it's a free cache-hit. So relay volume is the
  ~1-3% residual-failure tail — tens/day at small scale. This conserves the IP's "trust"
  (residential reputation is a *depletable* resource; over-pumping re-walls it).
- The PO-token route was investigated and REJECTED (doesn't help ANDROID_VR; WEB+pot →
  SABR). See `htl-youtube-resilience` memory.

## Architecture

```
Worker (/api/audio cold path)
  └─ datacenter resolve, 6 retries (server/youtube.ts playerWithRetry)  ← usually succeeds
       └─ on exhaustion + YT_RELAY_* set:  resolveAudio(v, auth, relayFetch)   ← FALLBACK
            POST https://relay-b.handlingtheloop.com/fetch  (Cloudflare edge)
              └─ cloudflared tunnel (outbound-only) → fgb :8088
                   └─ htl-relay → YouTube from fgb's residential IP 98.195.95.58
            (resolve AND byte-stream BOTH via the relay → googlevideo IP-lock holds)
```

## The relay (`htl-relay`, Go, on fgb `/usr/bin/htl-relay`)

Source: `/tmp/relay/main.go` on the dev box (cross-compiled `GOOS=linux GOARCH=arm GOARM=7`).
A thin, locked-down forward relay — **all resolve logic stays in the Worker**:
- `POST /fetch` with headers `X-Relay-Secret` (auth), `X-Relay-Target` (URL), `X-Relay-Method`,
  and `X-Fwd-<name>` (forwarded to upstream, prefix stripped). Body forwarded for POST.
- **Host allowlist** (the SSRF/open-proxy lock): only `youtubei.googleapis.com`,
  `www.youtube.com`, `*.googlevideo.com`. Else 403.
- **IPv4-pinned** dialer (resolve + byte-fetch must share the family the googlevideo URL is
  locked to).
- **Concurrency cap** 6 (protect the home upstream). Runs as `nobody`, localhost-only.
- `/healthz` → `ok`.

## fgb (FortiGate-b) state

- OpenWrt 25.12 (apk), armv7 (Marvell Armada 385), 2 GB RAM, 26 GB free overlay.
- On a personal Tailscale tailnet; **`tailscale set --accept-dns=false`** applied (its DNS was
  hijacked by MagicDNS that couldn't reach its upstream → no public DNS → couldn't fetch).
  Now uses its own dnsmasq. Reversible: `--accept-dns=true`. SSH to fgb rides Tailscale
  (100.x), so don't break Tailscale connectivity.
- Public egress IP `98.195.95.58` (Houston). Double-NAT behind a Google Nest — fine for
  cloudflared (outbound-only). VERIFIED clean for YouTube (8/8 ANDROID_VR OK, byte-probe 206).
- `curl` installed (for testing; relay binary is dependency-free).

## Services (procd, boot-persistent, respawn)

- `/etc/init.d/htl-relay` — runs `/usr/bin/htl-relay` as `nobody`, env from
  `/etc/htl-relay.env` (600). `RELAY_SECRET` (64-hex), `RELAY_ADDR=127.0.0.1:8088`.
- `/etc/init.d/cloudflared` — `cloudflared --no-autoupdate --config /root/.cloudflared/config.yml tunnel run`.
- Tunnel `relay-b`, ID `73ba5e75-ddea-47c9-bc8e-c108e57cd194`. Creds
  `/root/.cloudflared/73ba5e75….json`. Config ingress: `relay-b.handlingtheloop.com` →
  `http://127.0.0.1:8088`, else `http_status:404` (scoped to the one port).
- DNS: CNAME `relay-b.handlingtheloop.com` → `73ba5e75….cfargotunnel.com` (no home IP in DNS).

## Worker hook (committed `af64585`, UNDEPLOYED, INERT until secrets set)

- `server/youtube.ts`: `type Fetcher`, `makeRelayFetch(url, secret)`, threaded through
  getVisitorData/rawPlayer/playerWithRetry/resolveAudio/fetchRange/audioChunks (default =
  direct fetch → no behaviour change).
- `worker/index.ts` `/api/audio`: on resolve-exhausted, if `YT_RELAY_URL`+`YT_RELAY_SECRET`
  set, retry resolve + stream via the relay (`via` fetcher reused for bytes). Env type +
  import added.

## To ACTIVATE (user)

```bash
printf %s "https://relay-b.handlingtheloop.com" | npx wrangler secret put YT_RELAY_URL
tr -d '\n\r' < /tmp/relay/secret.txt | npx wrangler secret put YT_RELAY_SECRET   # match fgb byte-for-byte
# recover secret if /tmp wiped:  ssh fortigate-b 'sed -n "s/^RELAY_SECRET=//p" /etc/htl-relay.env'
./deploy.sh    # ships af64585 (+ the rest of the undeployed tree)
```

## Operate

- Health: `curl -s https://relay-b.handlingtheloop.com/fetch` → 403 (no secret = good). Local:
  `ssh fortigate-b 'curl -s localhost:8088/healthz'` → ok.
- Logs: `ssh fortigate-b 'logread | grep -iE "cloudflared|htl-relay" | tail'`.
- Rotate secret: regen → update `/etc/htl-relay.env` + `/etc/init.d/htl-relay restart` + re-put `YT_RELAY_SECRET`.
- Add **fga** as exit #2 (failover): fga (`76.142.104.241`, proven-clean, OpenWrt 24.10, has
  curl) — same steps; Worker would round-robin/failover between relays.

## Security follow-ups (see docs/security-handoff.md Tier 2)

Add Cloudflare Access (service token) on the hostname; add a per-time rate-limit to the relay;
secret-rotation runbook.
