# Deploy runbook

Two Cloudflare Workers off one repo, sharing one D1 (`htl-db`) and one R2 (`htl-audio`):

| Worker | Config | Domain | What it is |
|---|---|---|---|
| `htl` (public) | `wrangler.jsonc` | handlingtheloop.com | the SPA + audio proxy + community/analysis API |
| `htl-admin` | `wrangler.admin.jsonc` | admin.handlingtheloop.com | Cloudflare Access–gated moderation/DMCA console |

## Public worker

**Always deploy with `./deploy.sh`, never `pnpm deploy`.** Vite copies ~950 MB of model weights into `dist/models/`, and individual `.onnx` files exceed Cloudflare's 25 MiB asset cap. `deploy.sh` builds, then `rm -rf dist/models` (weights load from HuggingFace at runtime), then deploys.

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
