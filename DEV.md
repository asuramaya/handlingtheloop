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

### Skip Google: the dev shortcut login

To avoid the OAuth setup entirely, set `DEV_LOGIN=1` in `.dev.vars`, then visit:

```
http://localhost:8787/api/auth/dev?name=Hector   # signed in instantly as a real local user
```

It mints a real D1 user + session (no Google), so rooms / broadcast / follow / block
all work. Use a **different `?name=`** in a second browser (or incognito) to be a
**different real user** — the way to test multi-user follow/block and host↔listener.
This route is gated on `DEV_LOGIN`, which is **never set in production**, so it 404s
there. (A *public broadcast listener* needs no login at all — just open the room.)

To test **shared sessions / social**: open two browser tabs against `:8787`, start a
session in one, knock from the other. For the **broadcast plane**: dev-login, then
**Session → ● Go live**, and open an incognito window as the anonymous listener.

### Join from a phone on the LAN

```
pnpm worker:lan       # wrangler dev --ip 0.0.0.0 → reachable on your LAN IP:8787
```

On the phone (same Wi-Fi), open `http://<your-lan-ip>:8787` (e.g. `http://172.20.20.20:8787`;
find yours with `ip route get 1.1.1.1`). Sign in with the dev login —
`http://<lan-ip>:8787/api/auth/dev?name=Phone` — or just tune into a live room (anon).
The app is origin-relative (WebSocket uses `location.host`), so nothing is hardcoded to
localhost. **Cross-origin isolation is OFF over plain-HTTP LAN** (it needs HTTPS/localhost),
but that only disables threaded stem *separation* — which phones never do anyway — so
listening, playback, and R2 stem *download* all work. If the page can't load, allow inbound
TCP 8787 through the laptop's firewall.

## Harnesses

Two things in this app cannot be tested from jsdom, and both have a real harness
that drives real code:

```bash
pnpm dev                                  # both need the dev server up
pnpm draglab                              # the UI: menus, drag/drop, sync
pnpm draglab --headed                     # watch it
pnpm draglab --only 12                    # one scenario (index from its own listing)
node scripts/fxlab/…                      # the DSP: real worklets, measured
```

**draglab** runs the actual app in headless Chromium and asserts on what is
RENDERED. It exists because the preset menus were "fixed" five times from
screenshots and broke again every time: what decides where a drop lands is
`document.elementFromPoint` over floating windows with their own stacking,
clipping and hover-dismissal, and none of that is visible in the source or
reachable from a unit test — jsdom has no layout, so every rect is zeroes and
every hit-test answers the same thing.

It also carries a **fake account** (`scripts/draglab/account.mjs`): `page.route`
stands in for the whole signed-in server, so cross-device sync is drivable on one
machine with no D1 and no OAuth.

```js
const acct = await fakeAccount(page, { settings: { fxBanks: { eq: bankOf("MINE", "Bass Kill") } } });
acct.pushes / acct.lastPush   // what left this device
acct.setRemote(data, ts)      // another device just wrote
acct.fail(413)                // the server starts refusing (the 256 KB cap)
await acct.done()             // always in a finally
```

Every bug this area has is about ORDER — the account blob lands after mount, two
devices write in the wrong sequence, a push is refused and nobody says so. Faking
the *server* rather than the client is what keeps it honest: the app runs its real
`fetchMe`, reconcile, debounce and push.

**Touch is driven too**, via CDP `Input.dispatchTouchEvent` — Playwright's mouse
emits `pointerType: "mouse"`, which arms a drag on the first pixel and skips the
gesture race entirely. The race that matters: a drag arms after 180 ms of
stillness, the long-press row menu fires at 460 ms, and whichever happens first
cancels the other.

⚠ **A green harness on a synthetic path is not evidence about a real one.**
Playwright's mouse teleports — one event at the destination, no intermediate
elements, no unmounts under a moving pointer. When a bug report survives a passing
test, suspect the path, not the report.

## Production

**`./deploy.sh`, not `pnpm deploy`** — see [DEPLOY.md](./DEPLOY.md) for why (model
weights would blow Cloudflare's asset cap) and for the admin worker, D1 migrations
and Access setup. `deploy.sh` runs the worker typecheck + the full test suite
before it touches the edge; `SKIP_TESTS=1` exists and should stay unused.

Secrets are set with `wrangler secret put <NAME>` and are write-only — no CLI call
reads one back. Never committed. **Do not deploy unless asked.**
