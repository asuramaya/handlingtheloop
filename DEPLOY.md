# Deploy runbook

Two Cloudflare Workers off one repo, sharing one D1 (`htl-db`) and one R2 (`htl-audio`):

| Worker | Config | Domain | What it is |
|---|---|---|---|
| `htl` (public) | `wrangler.jsonc` | handlingtheloop.com | the SPA + audio proxy + community/analysis API |
| `htl-admin` | `wrangler.admin.jsonc` | admin.handlingtheloop.com | Cloudflare Access–gated moderation/DMCA console |

## Public worker

**Always deploy with `./deploy.sh`, never `pnpm deploy`.** Vite copies the stem model weights (~950 MB) into `dist/models/`, and individual weight files exceed Cloudflare's 25 MiB asset cap. `deploy.sh` runs the pre-deploy gate (worker typecheck + the full test suite — `SKIP_TESTS=1` exists and should stay unused), builds, `rm -rf dist/models` (weights load cross-origin from HuggingFace at runtime), then deploys.

```bash
./deploy.sh
```

## Admin worker

```bash
pnpm deploy:admin          # = wrangler deploy -c wrangler.admin.jsonc
```

No `vite build` (it serves inline HTML). `workers_dev:false` — reachable only via the Access-gated custom domain.

### One-time Access setup
1. Cloudflare dashboard → **Zero Trust → Access → Applications** → add a **Self-hosted** app for `admin.handlingtheloop.com` with a **policy** that Includes your email. (One-Time PIN login is fine.) Note its **Audience (AUD) tag**.
2. Set the three secrets **with `-c` or they land on the wrong worker**:
   ```bash
   wrangler secret put CF_ACCESS_TEAM_DOMAIN -c wrangler.admin.jsonc   # <team>.cloudflareaccess.com (bare host, no https://)
   wrangler secret put CF_ACCESS_AUD         -c wrangler.admin.jsonc   # the AUD tag from step 1
   wrangler secret put ADMIN_EMAILS          -c wrangler.admin.jsonc   # comma-separated allowlist
   wrangler secret list -c wrangler.admin.jsonc                        # confirm all three
   ```
   Until set, the worker fails closed (403). The 403 body names the exact reason (only visible post-Access) — `not configured`, `iss mismatch`, `aud mismatch`, `email not in ADMIN_EMAILS`, etc.
   - **Team domain** = the host in the Access login URL (`https://<team>.cloudflareaccess.com/...`), or Zero Trust → Settings → Team domain.

## Secrets and vars

Secrets go through `wrangler secret put` and are write-only — no CLI reads a value back, so keep
your own copy. Non-secret config lives in `wrangler.jsonc`'s `vars` block; that file is public.

| Name | Kind | What breaks without it |
|---|---|---|
| `TOKEN_ENC_KEY` | secret | OAuth tokens can't be encrypted at rest — connected services fail |
| `INTERNAL_SECRET` | secret | nothing: the DO→Worker bridge falls back to `TOKEN_ENC_KEY`. **Set it anyway** — the fallback puts the at-rest encryption key in a request header on every @mention |
| `PUBLIC_ORIGIN` | var | nothing visible: the room DO captures its bridge origin from the first connect URL and pins it forever. Set it to whichever origin serves `/api` |
| `APP_HOST` | var | nothing: unset means one origin serves everything (see below) |
| `SITE_HOST` | var | nothing visible, but apex and www both answer and each claims itself canonical in its own share card. **Worth setting today**, split or no split |

### Root or www?

**Root.** Cloudflare's CNAME flattening removes the only technical reason anyone ever preferred
`www`, and here the share link *is* the product surface — `handlingtheloop.com/@nina` is the thing
people paste into a chat. Four characters on every share is a real difference; nothing on the www
side of the ledger costs four characters.

What actually matters is picking **one** and 301ing the other, which is what `SITE_HOST` does. Both
hostnames are routed, so without it both serve the same document and `ogMetaFor` stamps `og:url`
from the request's own origin — a profile shared from `www` claims `www`, the same profile shared
from the apex claims the apex, and the two split their own signal. Set `SITE_HOST` to
`handlingtheloop.com` and www becomes a redirect.

If you ever want www instead, set `SITE_HOST` to `www.handlingtheloop.com` — the redirect runs the
other way with no code change.

```bash
wrangler secret put INTERNAL_SECRET      # paste `openssl rand -base64 32`
```

## Splitting the landing site off the app (optional)

Unset `APP_HOST` and one origin serves everything — the shape this has always run in. Set it and
the bare domain becomes a landing site while the app moves to its own hostname.

**Why bother:** the app stamps `COOP: same-origin` + `COEP: credentialless` on every document so
`crossOriginIsolated` is true, which is what unlocks SharedArrayBuffer and threaded wasm for stem
separation. Those same headers break what a marketing page is made of — YouTube embeds,
third-party widgets, analytics. Two hostnames let each have the headers it needs.

**What the split does** (all of it in `server/hosts.ts`, tested in `server/hosts.test.ts`):

- `APP_HOST` serves the SPA, the API, the WebSocket, and the isolation headers — unchanged.
- The bare domain serves `public/landing.html` at `/`, with no isolation headers.
- `/@handle` and `/set/:id` stay on the bare domain and keep their OG card there — the card belongs
  at the URL that was actually shared — then hand the human across with a `<meta refresh>`.
- Every other app path 301s to `APP_HOST`, query string intact.
- `/api/*`, `/api/room`, `/internal/*`, `robots.txt`, `sitemap.xml`, `favicon.ico` and
  `/.well-known/*` keep answering on **both**, so a cutover doesn't break open tabs, live sockets,
  or the OAuth redirect URIs already registered against the old hostname.

**Cutover checklist:**

0. Set `SITE_HOST` first, on its own, and let it settle. It is independent of the split and worth
   doing regardless.
1. Add the DNS record and a Worker route for `app.handlingtheloop.com` (custom domain).
2. Register the new redirect URIs — `https://app.handlingtheloop.com/api/auth/{google,spotify,tidal}/callback`
   — with all three providers. No code change (they derive from the request origin), but TIDAL
   matches exactly: scheme, host and path.
3. Set `"APP_HOST": "app.handlingtheloop.com"` and change `PUBLIC_ORIGIN` to the same origin.
4. Deploy, then check: the apex serves the landing, `/@somehandle` still previews correctly when
   pasted into a chat, and a deep link like `/settings` bounces to the app.
5. Announce the sign-in. **The session cookie is host-only** (`HttpOnly; Secure; SameSite=Lax`, no
   `Domain`), so everyone signs in once more on the new origin.

**Do not** widen the cookie with `Domain=.handlingtheloop.com` to avoid that. It would also send
the session to `admin.handlingtheloop.com` — a separate, Access-gated worker — and to every
subdomain added afterwards.

**Known one-time cost:** `localStorage` and OPFS are origin-scoped, so anything held only in the
browser stays behind on the old origin — MIDI maps, keymaps, colour profiles, sampler regions, pad
modes, preset banks, and the cached stem PCM. Signed-in users re-sync from D1 and barely notice;
anonymous users start fresh. There is no clean cross-origin handoff under COOP.

## D1 migrations

Schema lives in `migrations/`. Order matters; `wrangler` tracks what's applied.
```bash
wrangler d1 migrations apply htl-db --local    # dev / wrangler dev
wrangler d1 migrations apply htl-db --remote    # production
```
Migrations are additive (`CREATE TABLE IF NOT EXISTS`); safe to re-run. The community/analysis endpoints fall back gracefully if a table isn't migrated yet, so deploy order vs migrate order doesn't matter.

## First-run

After deploying + migrating, sign in to `admin.handlingtheloop.com` and click **Reindex from R2** once to seed the community index from existing cached objects. From then on every new cache self-indexes.

## Quick reference

```bash
./deploy.sh                                   # public worker
pnpm deploy:admin                             # admin worker
wrangler d1 migrations apply htl-db --remote  # prod schema
wrangler tail htl --format pretty             # live logs (public)
wrangler tail htl-admin --format pretty       # live logs (admin)
wrangler d1 execute htl-db --remote --command "SELECT COUNT(*) FROM community_tracks"
```
