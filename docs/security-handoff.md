# Security Handoff — xxit / Handling The Loop

**Audience:** a security-focused agent picking up where the engine/audio agent left off.
**Date:** 2026-06-22. **Reviewer:** prior agent did a *grounded but shallow* pass (greps + spot-reads), not a full audit.

This app is a serverless DJ web app on Cloudflare (Worker + R2 + D1 + Durable Objects), browser-heavy (Web Audio + local wasm DSP), with accounts (Google/Spotify/Tidal OAuth), a social/multi-user layer (profiles, follow graph, live broadcast, crowd chat, moderation), a public community audio cache, and a **new residential YouTube-fetch relay** running on a home FortiGate (see `docs/youtube-relay.md`).

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

### Tier 1 — multi-user authorization (highest value, NOT yet audited)
The social/room layer is the most code, newest, built fast by a concurrent agent. The room state machine has the right *shape* (`server/roomState.ts:54` `roleOf`, `PUB_ALLOWED`, `canDriveIntent`) but completeness is unverified.

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
