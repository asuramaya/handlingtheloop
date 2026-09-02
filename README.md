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
pnpm check      # both tsc projects + the test suite — the pre-commit gate
pnpm draglab    # drive the real UI in headless Chromium (needs `pnpm dev` running)
./deploy.sh     # build + gate + wrangler deploy  (NOT `pnpm deploy` — see DEPLOY.md)
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
  │ decode/DSP        │            miss ─▶ VISIONOS player API ─▶ direct url
  ◀── audio/mp4 ──────┘                 └─▶ capped range chunks ─▶ stream + cache
```

- **Extraction** (`server/youtube.ts`): the **VISIONOS** Innertube client
  (clientName 101, one of yt-dlp's `REQUIRE_JS_PLAYER:false` clients) returns
  **direct stream URLs** — no PoToken, no signature cipher, nothing to decipher.
  It only needs a cached `visitorData` token. Pure `fetch`, so it runs in a
  Worker. It replaced ANDROID_VR on 2026-08-24: YouTube began requiring a GVS PO
  token for android_vr range requests past ~1 MB, which 403s every track. That is
  the arms race in one line — see the comment block above `VISIONOS_VERSION` for
  the probe that established it.
- **Throttle**: a naive GET of a googlevideo URL is capped to ~32 KB/s. We never
  solve the `n` param — we download in **1 MB range chunks**, which serve at full
  speed (~15 MB/s) and stay under the Worker subrequest limit.
- **R2 cache**: each track is fetched from YouTube once, stored in R2 by videoId,
  then served from the edge (no YouTube call, no egress cost) — keeps it on the
  free tier.
- **Search / playlists**: `youtubei.js` (its `cf-worker` build) for the stable
  browse endpoints; metadata comes from the player client's `videoDetails`.

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

**Performance** — 8 hot cues per deck, beat loops (`1/2/4/8`, **SHIFT →
`16/32/48/64`**), FLX4-style manual loop (`IN`/`OUT`/`EXIT`/`RELOOP`), **loop
move** (grid-locked) and **save-loop-to-pad** via SHIFT, **beat sync** (tempo +
phase), **key-lock**, **quantize/snap**, **beat jump / skip**, **tap-to-seek**
(needle drop). A **SHIFT** modifier (on-screen button + the keyboard Shift key)
remaps the jog, pads, and transport.

**Mixer** — per-channel TRIM + 3-band EQ + **HP/LP filter** + LEVEL fader, with
center-detent knobs and dB/% readouts; a **master limiter** and anti-click
envelopes keep it clean; equal-power crossfader.

**Effects** — a per-deck rack of 9 always-armed devices (EQ, COMP, DELAY, VERB,
SAT, MOD, CRUSH, GATE, NOISE), plus **stem CHAINS**: a chain claims some of the
separated stems and processes only those, so the four stems are a partition and
nothing is heard twice.

**Preset banks** — every device ships a bank you can actually curate: name your
own **sections**, drag presets between them, edit or delete a factory preset and
**revert** it later. Deleting a shipped preset writes a tombstone rather than a
hole, so a preset added in a later release still reaches a bank you organised a
year ago. The shipped arrangement is 124 presets in 50 sections across the ten
banks (chains included, on the same engine). Restore is in Settings ▸ Audio,
deliberately far from the deck.

**Stays put** — full session (tracks, mixer, cues, loops, play state, the FX rack
and your stem chains) **restores on refresh** via an IndexedDB audio cache.
Signed in, your preset banks, MIDI maps, colour themes and keymaps follow you to
another machine; signed out, everything stays local.

**Stems** *(in progress)* — separate a track into vocals/drums/bass/other once on
a capable device, cache to R2, and let phones just download them. See
[ROADMAP](./ROADMAP.md).

**Library** — Collection + Playlists persisted to localStorage; native YouTube
search/Explorer, playlist import, rekordbox-style track table.

## Controls

| Control | Action | + SHIFT |
|---|---|---|
| Tap waveform | Needle-drop seek | — |
| Drag waveform | Scrub (audible) | — |
| Wheel / pinch | Zoom (shared by both decks) | — |
| Knob / fader | Drag to set · **double-tap / right-click to reset** | — |
| `CUE` | Set cue (paused) / jump to cue (playing) | Jump to **start** |
| `▶` | Play / pause | Play **from cue** |
| `SYNC` | Match the other deck's BPM + phase | Reset **pitch** to 0% |
| `KEY` | Key-lock (master tempo) | **Reset** channel (EQ/filter/trim/tempo) |
| Hot-cue pad | Set / jump | **Clear**, or **save the active loop** to it |
| `IN`/`OUT`/`EXIT` | Manual loop in/out, exit/reloop | — |
| `1/2/4/8` | Beat loop of that length | Big loops **16/32/48/64** |
| `◀◀ ◀ ▶ ▶▶` | Beat jump / skip | **Move the loop** (grid-locked) |
| `⌗` | Quantize — snap to grid | — |
| FILTER knob | Center = off · left = LP · right = HP | — |

The **SKIP** and **TEMPO ±** pills (center mixer) set the beat-jump size and the
pitch-fader range.

## Project structure

```
src/htl/          the @htl internal library (path alias "@htl"):
  audio/          AudioEngine, Deck, Eq3, decode, trackCache, pitchWorklet
  analysis/       LOD pyramid + beatgrid
  media/          youtube source/api + user-auth (cookie) headers
  library/        Collection + Playlists store
  persistence/    Store (versioned localStorage) + IndexedDB audio cache
  state/          settings + session snapshot
  stems/          stem R2 cache + (pending) on-device separation
src/components/   DeckLane, DeckControls, ChannelStrip, WaveformViewport,
                  Knob, Fader, Explorer, TrackTable, LibraryPanel, SettingsPanel
server/           youtube.ts (resolver), innertube.ts (search), api.ts (dev)
worker/index.ts   Cloudflare Worker: static SPA + /api/*
wrangler.jsonc    Worker + R2 + assets config

See **[ROADMAP.md](./ROADMAP.md)** for status, known issues, and what's next.
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
- **Extraction is an arms race** — if YouTube tightens the current player client,
  bump `clientVersion` in `server/youtube.ts` to match yt-dlp's current value.
  That's the only moving part.
- **Cloud-IP rate limits** — YouTube increasingly blocks Cloudflare's IPs with a
  "confirm you're not a bot" wall. The R2 cache means popular tracks rarely hit
  YouTube; for fresh tracks, **Settings → YouTube access** lets a user paste
  their own cookie so the Worker can authenticate with *their* session. That
  cookie is stored only in the browser, sent only to this app's Worker, forwarded
  to YouTube, and **never stored server-side** (see the in-app privacy notice).
- **No secrets in this repo** — the player client credentials are the well-known
  public YouTube-on-TV values (the same ones in yt-dlp and youtubei.js), and are
  overridable via Worker secrets; there are
  no API keys or tokens. Add a license before treating this as reusable.

## License

No license yet — all rights reserved by the author until one is added.
