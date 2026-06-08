# htl — Handling The Loop

A browser-based, **serverless** DJ application that mixes public YouTube tracks,
rekordbox / DDJ-FLX style. Two decks, a real Web Audio mixer, hot cues, beat
loops, beat-sync, key-lock, and audible scrubbing — all running from **one
Cloudflare Worker** plus the browser. No app to install, no backend to manage.

**Live:** https://handlingtheloop.com

> Intended for non-copyrighted / cleared material. YouTube audio extraction is
> subject to YouTube's Terms of Service — see [Caveats](#caveats).

---

## Quick start

```bash
pnpm install
pnpm dev        # Vite dev server at http://localhost:5173 (no binaries needed)
pnpm worker     # build + run the real Cloudflare Worker locally (workerd)
pnpm deploy     # build + wrangler deploy
pnpm typecheck  # tsc
```

Search a track in the bottom bar, hit **A** or **B** to load it to a deck (or
drag an audio file onto a lane). Everything else — decode, waveform, BPM, all
DSP — happens in the browser.

## How it works

Real DJ manipulation needs sample-level PCM through the Web Audio API, but a web
page can't fetch YouTube audio (CORS), and YouTube hides stream URLs behind
PoToken/cipher for most clients. The whole backend is **one Cloudflare Worker**;
the browser does the heavy compute.

```
                Cloudflare Worker (pure JS, no binaries)
browser ──────▶ /api/audio?v=  ──▶ R2 cache hit? serve it
  │ decode/DSP        │            miss ─▶ ANDROID_VR player API ─▶ direct url
  ◀── audio/mp4 ──────┘                 └─▶ 1 MB range chunks ─▶ stream + cache
```

- **Extraction** (`server/youtube.ts`): the **ANDROID_VR** Innertube client
  (yt-dlp's `REQUIRE_JS_PLAYER:false` client) returns **direct stream URLs** — no
  PoToken, no signature cipher, nothing to decipher. It only needs a cached
  `visitorData` token. Pure `fetch`, so it runs in a Worker.
- **Throttle**: a naive GET of a googlevideo URL is capped to ~32 KB/s. We never
  solve the `n` param — we download in **1 MB range chunks**, which serve at full
  speed (~15 MB/s) and stay under the Worker subrequest limit.
- **R2 cache**: each track is fetched from YouTube once, stored in R2 by videoId,
  then served from the edge (no YouTube call, no egress cost) — keeps it on the
  free tier.
- **Search / playlists**: `youtubei.js` (its `cf-worker` build) for the stable
  browse endpoints; metadata comes from the ANDROID_VR `videoDetails`.

Per deck the audio graph is:

```
source → [key-lock pitch-shift worklet] → EQ3 → trim → level → crossfader → master
```

Tempo is `playbackRate` (vinyl mode); **key-lock** inserts a pitch-shift
AudioWorklet set to `1/rate` so the key holds when you pitch.

## Features

**Decks** — load from YouTube search or local file; play/cue; **audible
scrubbing** (drag the waveform, hear it like a jog wheel, forward + reverse).

**Waveform viewport** — one continuously-zoomable view per deck (whole track ↔
per-sample) via an LOD peak pyramid. Drawn on a **real-time x-axis** and with
**shared zoom**, so the two stacked grids line up for beatmatching. Colored by
frequency (low/mid/high), adaptive beat→bar→phrase grid with bar numbers, and
contextual markers (cue, hot cues, loop in/out).

**Performance** — 8 hot cues per deck (lit in cue color), beat loops
(`1/2/4/8` + FLX4-style `IN`/`OUT`/`EXIT`/`RELOOP`), **beat sync** (tempo + phase),
**key-lock**, **quantize/snap** to grid, **beat jump** (±beat / ±bar).

**Mixer** — per-channel TRIM + 3-band EQ + LEVEL fader, crossfader.

**Library** — Collection + Playlists persisted to localStorage; native YouTube
search/Explorer, playlist import, rekordbox-style track table.

## Controls

| Control | Action |
|---|---|
| Drag waveform | Scrub (audible) |
| Wheel / pinch / `+ −` | Zoom (shared by both decks) |
| `CUE` | Set cue (paused) / jump to cue (playing) |
| Hot-cue pad | Set if empty, jump if set; ✕ or shift-click to clear |
| `IN`/`OUT`/`EXIT` | Manual loop in/out, exit/reloop |
| `1/2/4/8` | Beat loop of that length |
| `SYNC` | Match the other deck's BPM + phase |
| `KEY` | Key-lock (master tempo) |
| `⌗` | Quantize — snap cues/loops/jumps to grid |
| `◀◀ ◀ ▶ ▶▶` | Beat jump ±bar / ±beat |

## Project structure

```
src/audio/        AudioEngine, Deck, Eq3, analyze (pyramid + beatgrid),
                  decode, trackCache, pitchWorklet
src/components/   DeckLane, DeckControls, ChannelStrip, WaveformViewport,
                  LibraryPanel, Explorer, TrackTable, Knob, Fader
src/library/      useLibrary (Collection + Playlists), types
src/youtube/      client API (search/meta/playlist), source (audio fetch)
server/           youtube.ts (resolver), innertube.ts (search), api.ts (dev)
worker/index.ts   Cloudflare Worker: static SPA + /api/*
wrangler.jsonc    Worker + R2 + assets config
```

`server/*` is pure JS and runs identically in the Vite dev middleware and the
Worker, so dev and prod share one resolver.

## Deployment

`pnpm deploy` builds the SPA and pushes everything to Cloudflare with `wrangler`.
One Worker serves the static app **and** the `/api/*` routes; an R2 bucket
(`htl-audio`) caches resolved audio. `nodejs_compat` is on for `youtubei.js`.

## Caveats

- **YouTube ToS** — this extracts YouTube audio. Intended for non-copyrighted /
  cleared material; keep a consent gate in front of any public deployment.
- **Extraction is an arms race** — if YouTube tightens the ANDROID_VR client,
  bump `clientVersion` in `server/youtube.ts` to match yt-dlp's current value.
  That's the only moving part.
- **Cloud-IP rate limits** — YouTube occasionally 403s Cloudflare's IPs; the
  resolver retries with backoff, and the R2 cache means popular tracks rarely hit
  YouTube at all.

## License

No license yet — all rights reserved by the author until one is added.
