# Security Handoff — xxit / Handling The Loop

**Audience:** a security-focused agent picking up where the engine/audio agent left off.
**Date:** 2026-06-22. **History:** the FIRST pass was *grounded but shallow* (greps + spot-reads). A SECOND pass (also 2026-06-22) deep-read the whole credential + authz surface and **verified it clean** — see the "2026-06-22 DEEP AUDIT" block below, which supersedes the original Tier-1 worry.

This app is a serverless DJ web app on Cloudflare (Worker + R2 + D1 + Durable Objects), browser-heavy (Web Audio + local wasm DSP), with accounts (Google/Spotify/Tidal OAuth), a social/multi-user layer (profiles, follow graph, live broadcast, crowd chat, moderation), a public community audio cache, and a **new residential YouTube-fetch relay** running on a home FortiGate (see `docs/youtube-relay.md`).

## 2026-06-22 DEEP AUDIT — VERIFIED CLEAN (supersedes the Tier-1 worry below)

A full read of every credential + authorization surface. The shallow pass had the risk map **backwards**: the multi-user layer it flagged as the likely bug-home is the *strongest* part. All verified with evidence:

- **Room / Durable Object authz** (the headline worry) — **SOUND.** `host`/`pub` are stripped from the client URL and set server-side from the authed session (`worker/index.ts:949-957` `isHost = !!user && user.id === hostId && !asPublic`), so they're un-forgeable. Cross-site WS hijack is blocked by an Origin allowlist (`:914-919`) on top of SameSite. `PUB_ALLOWED` is enforced server-side (`room.ts:306`); a guest can't self-grant control (`control` rejects `!a.host`, `:336`); `canDrive` enforces per-deck permission on the hot intent path (`:878`); listeners/stage devices can't become the anchor (`nextAnchor`/`settle` exclude them). Every host action gates on `isHostDevice(self)` (reads the attachment, not a client claim).
- **OAuth token-at-rest** — **SOUND.** AES-GCM with a fresh random 12-byte IV per encryption (`server/crypto.ts:33` — no nonce reuse), SHA-256 key derivation from `TOKEN_ENC_KEY`. Refresh tokens never sit in D1 as plaintext. Token rows scoped `WHERE user_id=? AND provider=?` (`server/db/connections.ts`) — no IDOR.
- **Admin worker** — **SOUND.** Every route behind `verifyAccess` (fails closed). The JWT check verifies aud/exp/iss + email allowlist AND **hardcodes `RSASSA-PKCS1-v1_5`** rather than trusting the token `alg` header → immune to alg-confusion / `alg:none` (`server/access.ts:77-87`). Admin page uses a per-request nonce CSP, all DOM via `textContent`/`addEventListener`. (One `innerHTML` at `admin.ts:349` interpolates only server-computed numbers — not exploitable.)
- **accounts.ts / samples.ts** — **SOUND.** Every mutation: method gate + session-derived actor + ownership check (`viewer.id !== row.hostId → 403`; samples scoped `AND user_id=?`). OAuth `state` validated on all three providers; Tidal PKCE validated.
- **R2 key path** — **SOUND.** `isVideoId` is strict `/^[\w-]{11}$/`, so `a/${v}` can't traverse into `samples/` etc. No IDOR/traversal.
- **Invite codes** — **SOUND.** 96-bit CSPRNG (`crypto.getRandomValues(12)`); a code only lets you *knock* (host approves).
- **Dev fake-auth** — **NOT reachable in prod.** `server/api.ts` (DEV_AUTH + devStore) is imported ONLY by `vite.config.ts` (Vite middleware); the Worker entry `worker/index.ts` does not import it, and `handleApi(req,res)` uses Node `http` types the Worker can't invoke. Caveat documented: `DEV_AUTH` is fail-open if `process.env.NODE_ENV` is absent (as in a Worker), so keeping `api.ts` out of the Worker bundle is load-bearing.

**Fixes landed this pass** (commits `02ff036`, `261f62a`, build-green, since shipped): pinned sample-audio Content-Type (was replaying the uploader's — self-XSS ceiling); escaped `'` in OG meta (`ogEsc`); auth-gated `/api/audio/diag` (was anon — YouTube-budget burn + egress-IP disclosure); corrected the stale `vite.config.ts` prod-path comment.

**2026-06-22 — Tier 2 + Tier 3 DONE.** ① **Relay (Tier 2) — DONE + LIVE** (`b9c8c085`): Cloudflare Access service-token + token-bucket rate-limit + the existing host-allowlist/IPv4-pin/secret. ② **Cookie path (Tier 3) — REMOVED** (`7c873bb`): the pasted youtube.com streaming cookie is gone end-to-end (client store/parse, Worker `x-htl-yt-cookie` accept, server `authHeaders`/`cookieClient` browse, copy) — the relay covers the bot wall, so a full Google session never transits the Worker; signed-in features are OAuth-only. ③ **ORT supply-chain (Tier 3) — SELF-HOSTED** (`a3cef85`): onnxruntime-web vendored same-origin under `/ort/` via a hash-pinned Vite build plugin (`vite.config.ts ortVendor`), `cdn.jsdelivr.net` dropped from `script-src` → the CSP now allows NO external script origin. **OWED: a real-browser stem-separation smoke (Chromium WebGPU + Safari/FF wasm) before fully trusting the self-hosted path.**

**Still remaining (optional/low):** make `DEV_AUTH` fail-closed (requires an opt-in env var; would change the `pnpm dev` workflow — left as-is, documented in `vite.config.ts`). Drop the unused `user_cookies` D1 table (migration 0006) in a later migration.

## Scope & rules of engagement

- **Do the security audit + hardening only.** The core engine/audio is owned by another agent — don't refactor it.
- **Concurrent agents share this tree.** Commit small, single-file-set, build-green deltas; stage ONLY your files; never `git add -A`. Verify shared files (`worker/index.ts`, `src/App.tsx`, `server/accounts.ts`) contain only your hunks before committing.
- **Build gates:** `pnpm exec tsc -b 2>&1 | grep -v "stems/"` + `pnpm exec tsc -p tsconfig.node.json` + `pnpm exec vitest run` (96 tests) + `pnpm build`.
- **Do NOT deploy** (`./deploy.sh` / `wrangler deploy`) — user-gated; the auto-mode classifier blocks it anyway.

## Verified GOOD (don't re-litigate; evidence in parens)

- **Session cookie** = `HttpOnly; Secure; SameSite=Lax; Path=/` (`server/session.ts` `cookie()`). Correct trio; Lax blocks cross-site POST CSRF by construction.
- **CSP is load-bearing** (`server/security.ts` `CSP`/`SECURITY_HEADERS`): `script-src 'self' 'wasm-unsafe-eval' blob: https://cdn.jsdelivr.net` (NO `'unsafe-inline'`), `object-src 'none'`, `base-uri 'self'`, `frame-ancestors 'none'`, `form-action 'self'`, `x-frame-options: DENY`. Strong anti-XSS + anti-clickjacking.
- **No `dangerouslySetInnerHTML`** anywhere in `src/` → React auto-escaping intact → UGC-as-text.
- **D1 parameterized** — `IN (${ph})` is a placeholder *count* (`?,?,?`), values via `.bind()` (`server/db/analysis.ts:37,66`). `ALTER TABLE … ${col}` (`server/db/sets.ts:19`) is a hardcoded migration list, not user input.
- **Rate limiting** on write paths: `RL_AUDIO` (cold resolves, `worker/index.ts:264,289`), `RL_WRITE` (×4: 559/685/734/828), `RL_ACOUSTID` (484).
- **Admin worker isolated** — separate worker, Cloudflare Access JWT verify, fail-closed, own nonce CSP (`server/admin.ts`).
- **Reference authz pattern (CORRECT)** — `server/accounts.ts:376` `/api/follow|block`: `POST`-only (405 else), actor from `currentUser(env, req)` (session), 401 if anon, target resolved server-side from body `handle`, self-action guarded. **This is the pattern to verify holds EVERYWHERE.**

## FINDINGS & OPEN QUESTIONS (the actual audit)

### Tier 1 — multi-user authorization — ✅ RESOLVED (see the 2026-06-22 DEEP AUDIT block above)
**The questions below were the shallow pass's open worries. The deep audit answered all of them: every path checks the method, derives the actor from the session, and authorizes against it; `host`/`pub` are un-forgeable; listeners can't drive/anchor; mod is host-gated. Kept here as the checklist that was walked, not as open work.**

The social/room layer is the most code, newest, built fast by a concurrent agent. The room state machine has the right *shape* (`server/roomState.ts:54` `roleOf`, `PUB_ALLOWED`, `canDriveIntent`) — and the deep audit confirmed the *completeness* too.

Audit every state-changing path and confirm it (a) checks `req.method`, (b) derives the actor from the **session** (not a client-supplied id), (c) authorizes the action against that actor:
- **Sets** — `server/accounts.ts:252` DELETE, `:261` publish/unpublish, `:265` rename, `:270` trim. Q: does each confirm the set's `hostId === session user.id`? (IDOR: edit/delete another user's set by id.)
- **Profile** — `server/accounts.ts:551/618/642` PUT handlers. Q: scoped to the session user only? Can you PUT another user's profile/handle?
- **Samples** — `server/samples.ts`. Q: `GET /api/samples/:id/audio` + DELETE owner-checked? (memory says yes — verify.)
- **Room intents (Durable Object)** — `server/room.ts` socket → intent apply; `server/roomState.ts` `roleOf`/`canDriveIntent`. Q: can a listener/watcher drive a deck, become anchor, or send intents they shouldn't? Is the actor's role derived server-side per-connection, not client-claimed? Tests: `server/room.test.ts`, `roomState.test.ts`, `roomCrowd.test.ts`.
- **Moderation** — kick/ban/mute/blocklist/report (`server/roomCrowd.ts` + accounts). Q: only host/moderator can mod? Can a banned/muted user still post? Can report be abused (spam → admin)?
- **Crowd chat** — Q: is chat write rate-limited specifically (spam), and length/content-bounded?

### Tier 2 — the residential relay (fresh surface; see docs/youtube-relay.md)
- Public tunnel hostname `relay-b.handlingtheloop.com` gated ONLY by a shared secret (`X-Relay-Secret`). Host-allowlist (`youtubei.googleapis.com`/`*.googlevideo.com`/`www.youtube.com`) caps blast radius to "YouTube via the home IP," but there's **no second gate**. ACTION: add **Cloudflare Access** (service token) on the hostname; requires a small code add so `makeRelayFetch` (`server/youtube.ts`) sends `CF-Access-Client-Id/Secret` + 2 Worker secrets.
- Relay has a concurrency cap (6) but **no per-time rate limit** — a leaked secret could pull continuously. Consider a token-bucket in the relay (`/tmp/relay/main.go` on the dev box; binary on fgb at `/usr/bin/htl-relay`).
- Secret lives in 3 places (Worker secret `YT_RELAY_SECRET`, fgb `/etc/htl-relay.env` 600, `/tmp/relay/secret.txt`). Write a rotation runbook.

### Tier 3 — simplification & defense-in-depth
- **Remove the paste-your-YouTube-cookie path** — the single riskiest credential in the app (a full Google session transiting the Worker). The new relay covers cold loads, so this feature can be deprecated/deleted = a whole risk class gone. Trace `YtAuth.cookie` (`server/youtube.ts`) + the client cookie UI (`src/htl/media/auth.ts` ephemeral cookie section).
- **No state-changing GETs** — SameSite=Lax sends the cookie on top-level GET; confirm every mutation is POST/PUT/DELETE. `/api/follow` etc. are POST-only ✓; sweep the rest.
- **SRI** on the `cdn.jsdelivr.net` onnxruntime script (supply-chain; `wasm-unsafe-eval` is allowed for it).
- **R2 exposure** — confirm no route serves owner-scoped audio without the access check, and the `htl-audio` bucket isn't publicly listable (community pool is public *by design* via the D1 index; private samples must stay owner-gated).
- **OAuth state/PKCE** — Google/Spotify/Tidal flows: confirm `state` validated (seen at `accounts.ts:318` bad_state) and Tidal PKCE (`server/tidalAuth.ts`, env-gated, "v2 endpoints to-verify" per memory).

## Out of scope / non-goals
- Legal/DMCA (community pool redistributes copyrighted audio) — separate concern; admin worker has takedown tooling.
- The engine/audio/DSP code.
- The Tailscale tailnet config on the FortiGates (the relay rides cloudflared, not Tailscale).

## Useful entry points
`server/security.ts` (CSP/headers), `server/session.ts` (cookies), `server/accounts.ts` (auth + social routes), `server/room.ts` + `roomState.ts` + `roomCrowd.ts` (sessions/DO + crowd), `server/samples.ts`, `server/admin.ts` (admin worker), `server/access.ts`, `worker/index.ts` (route dispatch + rate limits). Memory index: `~/.claude/projects/.../memory/MEMORY.md`.
