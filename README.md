# htl — Handling The Loop

A browser-based, **serverless** DJ application that mixes public YouTube tracks,
rekordbox / DDJ-FLX style.

Two decks with a real Web Audio mixer — hot cues, beat loops, beat-sync,
key-lock, audible scrubbing and a vinyl-mode jog. On top of that: **stem
separation** in the browser, a **9-device FX rack** per deck with stem chains and
curatable preset banks, **auto-mix**, a **sampler**, **mic and headphone-cue
I/O**, USB-MIDI controllers and a gamepad, accounts that sync your setup across
machines, and **shared sessions** you can play in together or broadcast live.

All of it runs from **one Cloudflare Worker** plus the browser. No app to install,
no backend to manage — every heavy thing (decode, waveform, BPM, key, stems, every
effect) happens on your own machine.

**Live:** https://handlingtheloop.com

> Intended for non-copyrighted / cleared material. YouTube audio extraction is
> subject to YouTube's Terms of Service — see [Privacy & caveats](#privacy--caveats).

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
                        ┌─ stem chain (drums)  → [devices] ─┐
source → [stretch] ─────┼─ stem chain (vocals) → [devices] ─┼→ trim → level → crossfader → master
  (or 4 stem sources)   └─ master chain        → [devices] ─┘                                  ↑
                                                                              mic / line ─────┘
```

Tempo is `playbackRate` (vinyl mode); **key-lock** routes through a time-stretch
worklet (WSOLA by default, phase-vocoder opt-in) so the key holds when you pitch.
With stems separated, the deck runs **four synced sources** instead of one, and a
**chain** claims a subset of them — stems are a partition, so nothing is heard
twice and the chains sum back to the track.

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

**Stems** — separate a track into drums / bass / vocals / instruments with
HT-Demucs, in the browser. Separation runs once on a capable device and is cached
to R2, so **phones download rather than compute**. Every device renders its own
stems; a sliding-window OPFS pager keeps resident PCM under a byte budget so two
stem decks fit on a phone. Per-stem volume/mute/solo, and stems drawn layered in
the waveform. *(On-device GPU separation is disabled on iOS — see
[ROADMAP](./ROADMAP.md).)*

**Sampler** — 24 pads: 8 that grab a slice of the loaded track (the active loop,
else four beats from the playhead), 8 global file pads stored to your account, and
per-pad mode (oneshot / gate / loop), gain and pitch.

**Auto-mix** — a queue that beat-matches, key-matches and crossfades for you,
with phrase-anchored mix points and eager preload of the next track. **Smart
fader** does the same as a gesture: one crossfader move morphs tempo and swaps the
bass. Both reuse the same DSP the manual controls do.

**Controllers** — USB-MIDI on Chromium desktop (DDJ-FLX4 and Donner Starrypad
mapped out of the box, plus **MIDI-Learn** for anything else), an **Xbox gamepad**
as a DJ surface, and a full **keyboard map** — Tab switches deck focus and every
binding is remappable. Maps, colour themes and keymaps save as shareable profiles
and sync to your account.

**Jog / scratch** — a rekordbox-style jog with vinyl-speed motor, spinback and
Global SLIP.

**Key + analysis** — native key detection (chromagram → Camelot), ±12 semitone
pitch and key controls, SYNC with half/double-time, a dynamic beatgrid, and
acoustic fingerprinting (Chromaprint → AcoustID → ISRC) to identify what you
loaded.

**I/O** — a **headphone cue** bus (second output via `setSinkId`, per-deck
pre-fader PFL), **mic / line input** with talkover ducking and a sidechain tap,
and **set recording**.

**Lyrics** — a timestamped caption ribbon per deck, snapped to the playhead.

**Accounts + sync** — sign in with Google (or connect Spotify / Tidal for
catalogue). Your Collection, playlists, preset banks, MIDI maps, colour themes and
keymaps follow you to any machine. Signed out, everything stays local and nothing
leaves the browser.

**Play together** — a **shared session** syncs one account's devices, or invites
someone else in: control intents travel, the anchor holds authority, and a guest
adopts the host's tempo, pitch and EQ. **Go live** turns it into a broadcast any
listener can tune into, with a crowd tier for large rooms. Plus profiles,
following, presence, notifications, invite links, and a recorded-set lifecycle.

**Library** — Collection + Playlists, synced across devices and deduplicated by
track key; native YouTube search / Explorer, playlist import, a sortable resizable
rekordbox-style track table, and a **community pool** of tracks other people have
already cached.

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

The eight pads have four modes, each with a SHIFT peer — `U` `I` `O` `P` switch
between them, `1`–`8` fire them:

| Mode | Pads do | + SHIFT |
|---|---|---|
| `CUE` | 8 hot cues | — |
| `FX` | throw an effect while held | `FX2` — a latching second layer |
| `LOOP` | beat loops | `ROLL` — momentary loop roll |
| `SMP` | 8 slices of this track | `GLBL` — your uploaded one-shots |

`Tab` moves deck focus; every binding above is remappable in Settings ▸ Controls,
and the same actions are learnable to MIDI or a gamepad.

## Docs

**[docs/map.md](./docs/map.md)** is the whole system in one read — the layers, one
track's journey end to end, the engine, where state lives, the two sync planes,
and where to start reading. **[docs/README.md](./docs/README.md)** is the honest
inventory of what is documented and what is not.

Per-subsystem design notes live in [`docs/`](./docs) — written as the systems were
built, so they carry the *why* and the dead ends, not just the shape:

| | |
|---|---|
| [**map**](./docs/map.md) | ★ the whole system in one read — start here |
| [**docs/README**](./docs/README.md) | docs ↔ code inventory: what is covered, what is not |
| [app-architecture](./docs/app-architecture.md) | how App.tsx is decomposed; where a new feature plugs in |
| [analysis](./docs/analysis.md) | the beatgrid — and everything downstream that inherits its errors |
| [sync](./docs/sync.md) | the two sync planes: your setup across machines vs playing together |
| [stems](./docs/stems.md) | the shipped separation pipeline, and why phones never separate |
| [fx-rack](./docs/fx-rack.md) | the device rack, stem chains, and the preset/chain bank engine |
| [shared-session](./docs/shared-session.md) | rooms, anchors, intents, the attachment model |
| [social-layer](./docs/social-layer.md) | profiles, follows, presence, notifications, the three surfaces |
| [engine-stem-paging](./docs/engine-stem-paging.md) | the OPFS pager + SAB ring that make two stem decks fit on a phone |
| [audio-io](./docs/audio-io.md) | headphone cue, mic/line capture, recording |
| [smart-fader](./docs/smart-fader.md) | the one-gesture transition |
| [ddj-flx4](./docs/ddj-flx4.md) | the authoritative controller map (and the hardware's traps) |
| [youtube-relay](./docs/youtube-relay.md) | the residential relay, and what was rejected on the way |
| [security-handoff](./docs/security-handoff.md) | the security review and what is still open |
| [qa-session-smoke](./docs/qa-session-smoke.md) | the manual pass before a session ships |

[DEV.md](./DEV.md) covers running it locally, the harnesses, and testing sessions
across two tabs or a phone on your LAN. [DEPLOY.md](./DEPLOY.md) is the runbook.
[ROADMAP.md](./ROADMAP.md) is what works, what is half-built, and what is next.

## Project structure

```
src/htl/          the @htl internal library (path alias "@htl"):
  audio/          AudioEngine, Deck, Eq3, the 9 FX devices + their worklets,
                  fxPresets (the preset/chain BANK engine), stretch, decode,
                  trackCache, Recorder, MicInput, Sampler
  analysis/       LOD peak pyramid, beatgrid, key, colour palette
  automix/        mixability scoring + the auto-DJ driver
  fingerprint/    Chromaprint → AcoustID → ISRC
  gamepad/ midi/  control surfaces (both feed one onMidiEvent path)
  media/          youtube source/api + OAuth headers
  library/        Collection + Playlists (account-synced)
  persistence/    Store (versioned localStorage) + IndexedDB audio cache
  room/           shared-session protocol + client
  state/          settings, settingsSync (account LWW), session snapshot
  stems/          stem cache, separator worker, model registry
src/components/   the UI — DeckLane, DeckControls, FxStrip, WaveformViewport,
                  Explorer, TrackTable, LibraryPanel, SettingsPanel, RoomBar,
                  DiscoverScreen, ProfileScreen, SocialScreen, …
server/           pure-JS, shared by dev and prod: youtube.ts (resolver),
                  innertube.ts (search), oauth.ts, accounts.ts, api.ts
worker/index.ts   Cloudflare Worker: the SPA + every /api/* route
  ROOM / RELAY    Durable Objects: one per shared session, one crowd-shard tier
migrations/       D1 schema (additive; wrangler tracks what's applied)
scripts/draglab/  headless-Chromium UI harness (menus, drag, account sync)
scripts/fxlab/    DSP measurement harness (real worklets, headless)
docs/             per-subsystem design docs
```

`server/*` is pure JS and runs identically in the Vite dev middleware and the
Worker, so dev and prod share one resolver.

## Testing

```bash
pnpm check      # both tsc projects + the vitest suite — the pre-commit gate
pnpm draglab    # the UI, driven for real in headless Chromium (needs `pnpm dev`)
```

The unit suite is node-only and covers pure functions. **draglab** exists because
the parts that break most are the parts jsdom cannot model — `elementFromPoint`
over floating windows, stacking, clipping, hover-dismissal — so it drives the real
app and asserts on what is *rendered*. It also carries a fake account
(`page.route`) so cross-device settings sync is testable on one machine. See
[DEV.md](./DEV.md).

## Deployment

```bash
./deploy.sh          # public worker — NOT `pnpm deploy`
pnpm deploy:admin    # the Access-gated moderation console
```

`deploy.sh` runs a pre-deploy gate (worker typecheck + the full test suite), then
builds, then drops `dist/models` — the stem weights are ~950 MB and load
cross-origin from HuggingFace at runtime, and individual files exceed
Cloudflare's 25 MiB asset cap. Two Workers share one D1 (`htl-db`) and one R2
(`htl-audio`). Full runbook, D1 migrations and Cloudflare Access setup:
**[DEPLOY.md](./DEPLOY.md)**.

## Privacy & caveats

- **YouTube ToS** — this extracts YouTube audio. Intended for non-copyrighted /
  cleared material; keep the in-app consent/access flow honest in front of any
  public deployment.
- **Extraction is an arms race.** The player client is the only moving part. It
  moved on 2026-08-24, when YouTube began requiring a GVS PO token for
  `android_vr` range requests past ~1 MB — every track 403'd. VISIONOS
  (clientName 101) replaced it. If it tightens again, the fix is a different
  `REQUIRE_JS_PLAYER:false` client and a `clientVersion` bump in
  `server/youtube.ts`; track yt-dlp's client table.
- **Cloud-IP bot wall** — YouTube blocks Cloudflare's IPs with a "confirm you're
  not a bot" wall for fresh (un-cached) tracks. The R2 cache means popular tracks
  rarely hit YouTube at all; for the rest there is an optional **residential
  relay** (a small Go service on a home connection, reached over a Cloudflare
  tunnel with an Access service token) as the cold-load fallback.
- **The cookie-paste path is gone.** An earlier version let you paste a
  youtube.com cookie so the Worker could use your session. It was **removed
  end-to-end** in 2026-06 — client store, Worker header, and server use — so a
  full Google session never transits the Worker. Signed-in features are
  OAuth-only, and those tokens live in your browser and are forwarded per
  request, never stored server-side.
- **What leaves your browser.** Audio decode, waveform, BPM, key, stems and every
  effect run locally. Signed out, nothing syncs. Signed in, the things listed
  under *Accounts + sync* go to D1 as a last-write-wins blob, and separated stems
  go to R2 so other devices (and other people) can skip the compute.
- **No secrets in this repo** — the player-client credentials are the well-known
  public YouTube-on-TV values (the same ones in yt-dlp and youtubei.js) and are
  overridable via `wrangler secret put`; there are no API keys or tokens here.

## License

No license yet — all rights reserved by the author until one is added. The repo is
public to be read, not yet to be reused; open an issue if you want that to change.
