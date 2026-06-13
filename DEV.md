# Local development

Two ways to run the app locally. Pick by what you're working on.

## `pnpm dev` — fast loop (default)

```
pnpm dev          # Vite on http://localhost:5173, HMR
```

Vite serves the UI and mounts `server/api.ts` as middleware for `/api/*`. The media
routes (YouTube search/playlist/audio/stems/captions) hit real yt-dlp/Innertube.

The **account layer is emulated** (`server/devStore.ts`, file-backed under `.dev-data/`,
gitignored) so you can exercise it with zero config:

- **Sign in with Google** → instant fake login as a single "Dev User" (no real OAuth).
- `/api/me`, `/api/me/profile`, `/api/me/play` → the dev user + locally-logged top songs.
- `/api/me/settings` → **really persists** to `.dev-data/settings.json`, so cross-device
  settings sync (themes / keymaps / MIDI maps) round-trips and is testable.
- `/api/lyrics` → a file-backed pool under `.dev-data/lyrics/`.

What this path **can't** do: real Google/Spotify/TIDAL OAuth, and the real-time
shared-session / social (knock·approve·kick) which runs on a Durable Object. For those,
use `wrangler dev` below. (The Social screen still renders under `pnpm dev`; the live
relay just isn't wired.) Reset local account state by deleting `.dev-data/`.

## `pnpm worker` — full backend (real OAuth + social DO)

Runs the actual Cloudflare Worker against a **local** D1 + Durable Objects.

```
cp .dev.vars.example .dev.vars              # then fill in real values
wrangler d1 migrations apply htl-db --local # create the local D1 schema (once / after new migrations)
pnpm worker                                 # vite build && wrangler dev  → http://localhost:8787
```

For **real Google sign-in** you must, in the Google Cloud OAuth client, add the
Authorized redirect URI:

```
http://localhost:8787/api/auth/google/callback
```

(The redirect URI is derived from the request origin — `server/accounts.ts` — so a
missing `.dev.vars` or an unregistered localhost redirect URI is the usual reason
"Sign in with Google" fails locally.)

To test **shared sessions / social**: open two browser tabs against `:8787`, start a
session in one, knock from the other.

## Production

`pnpm deploy` (`vite build && wrangler deploy`). Secrets are set with
`wrangler secret put <NAME>` (never committed). Do not deploy unless asked.
