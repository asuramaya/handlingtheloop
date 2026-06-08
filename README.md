# xxit

Browser-based, serverless DJ software that mixes public YouTube playlists,
rekordbox-style. No controller/MIDI yet — core mixing and audio routing.

## How the audio works

Real DJ manipulation (waveforms, EQ, tempo, cue) needs sample-level access to
the audio, i.e. PCM flowing through the Web Audio API. A plain web page can't
fetch YouTube's audio bytes — `googlevideo.com` refuses cross-origin reads. The
whole backend is **one Cloudflare Worker** (pure JS, no binaries, no extra
services); the browser does all the heavy compute.

```
                  Cloudflare Worker (pure JS)
browser  ──────▶  /api/audio?v=  ──▶  ANDROID_VR player API ──▶ direct url
  │  decode/DSP        │                                    └─▶ 1MB range chunks
  ◀── audio/mp4 ───────┘ (streams bytes back)
```

The trick is avoiding YouTube's arms-race layers entirely (`server/youtube.ts`):

- **Client:** the **ANDROID_VR** Innertube client (yt-dlp's `REQUIRE_JS_PLAYER:
  false` client). Its formats carry **direct URLs** — no `signatureCipher`, no
  PoToken — so there's nothing to decipher. It just needs a `visitorData` token
  (fetched once, cached) to avoid `LOGIN_REQUIRED`.
- **Throttle:** a naive single GET is capped to ~32 KB/s unless the `n` param is
  solved. We never solve it — we download in **1 MB range chunks**, which serve
  at full speed (~15 MB/s).

So no yt-dlp, no PoToken, no `nsig`/signature deciphering — all of which were
tried and are either impossible in a Worker (yt-dlp is a binary) or broken in
pure JS (youtubei.js's player parser). Search/playlist use `youtubei.js`
(`cf-worker` build) for its stable browse endpoints; metadata comes from the
ANDROID_VR `videoDetails`. The same `server/*` logic runs in the Vite dev
middleware and the Worker (`worker/index.ts`).

Per deck the signal path is:

```
source -> [time-stretch*] -> EQ3 (low/mid/high) -> trim -> crossfader -> master
```

\* time-stretch (key-lock tempo) is the next engine stage to add; today tempo
uses `playbackRate` (pitch tracks tempo, like vinyl).

## Run it

```bash
pnpm install
pnpm dev          # Vite dev server, no external binaries needed
pnpm worker       # build + run the real Cloudflare Worker locally (workerd)
pnpm deploy       # build + wrangler deploy
```

Paste a YouTube URL/id into a deck and hit Load, or drag an audio file (works
offline). No external binaries — the dev server and the Worker share the same
pure-JS resolver.

## Status (MVP)

- [x] Web Audio engine: 2 decks, EQ3, equal-power crossfader, master
- [x] Transport: play/pause, cue, click-to-seek, tempo (vinyl mode)
- [x] Offline analysis: waveform peaks + coarse BPM estimate
- [x] Local-file input
- [x] **YouTube loading** — pure-JS ANDROID_VR resolver + chunked range stream
- [x] Session track cache (videoId → decoded buffer + analysis), instant reloads
- [x] **YouTube data API** — `/api/search`, `/api/playlist`, `/api/meta`
- [x] **Runs entirely in one Cloudflare Worker** (`worker/index.ts`) + browser
- [x] **Library** — Collection + Playlists, persisted to localStorage
- [x] **Explorer** — native YouTube search, load to deck A/B, add to collection
- [x] Playlist import (paste a playlist URL → saved playlist)
- [ ] Key-lock tempo (time-stretch stage)
- [ ] Musical key detection (the library's Key column)
- [ ] Phase-aligned beatgrid + sync
- [ ] Hot cues / loops
- [ ] Consent gate for non-copyrighted material

## Library / Explorer

The bottom half is a rekordbox-style browser: a sidebar (Explorer / Collection /
Playlists) over a track table (#, artwork, Title, Artist, BPM, Key, Time).
Tracks on a deck are tinted green. Double-click a row (or the A/B buttons) loads
it; the Explorer searches YouTube live and loads results straight into the
decks. BPM is filled in once a track is analyzed on load. Library *metadata*
persists in localStorage; decoded audio lives in an in-memory session cache.

## Deployment

`pnpm deploy` builds the SPA and pushes everything to Cloudflare with `wrangler`.
One Worker (`worker/index.ts`) serves the static app **and** the `/api/*` routes;
no other compute exists. `nodejs_compat` is on for `youtubei.js`. The browser is
the only other machine involved — it does decode, analysis, and all DSP. This is
the whole point: deploy a public page, users mix instantly, nothing else to run.

The YouTube extraction rides an arms race — if YouTube changes the ANDROID_VR
client requirements, bump the `clientVersion` in `server/youtube.ts` (mirror
yt-dlp's current value).

## Caveats

YouTube audio extraction is subject to YouTube's Terms of Service. This project
is intended for non-copyrighted / cleared material; keep the consent gate on.
