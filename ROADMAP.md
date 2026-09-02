# htl — Status, Known Issues & Roadmap

A living inventory of what works, what's half-built, what's broken, and where this
is going. Companion to the [README](./README.md).

> **Last trued against the code: 2026-09-01.** Anything below that reads as a plan
> and is not marked ✅ has been checked against the tree, not remembered.

> **Ethos / hard constraints** (don't break these):
> - The whole backend is **one Cloudflare Worker** + the browser. No sidecar, no
>   container, no extra server. The Worker stays **dependency-light and pure-JS**.
> - Heavy compute (decode, waveform, BPM, DSP, stems) runs **in the browser**.
> - Intended for **non-copyrighted / cleared** material. YouTube extraction is
>   ToS-sensitive — keep the consent/access flow honest (see Privacy in-app).

---

## ✅ What works today

- **Two-deck engine** (Web Audio): play/cue, vinyl-mode tempo (`playbackRate`),
  key-lock (pitch-shift worklet), 3-band EQ, TRIM, channel level, HP/LP **filter**
  per channel, equal-power crossfader, **master limiter**, **anti-click**
  envelopes on every play/cue/seek/loop, gliding tempo.
- **Performance**: 8 hot cues, beat loops (`1/2/4/8`, SHIFT → `16/32/48/64`),
  FLX4-style manual loop (IN/OUT/EXIT/RELOOP), **loop move** (grid-locked) and
  **save loop to a pad** via SHIFT, beat-sync (tempo + phase), beat-jump / skip,
  quantize/magnet, **audible scrubbing** + **tap-to-seek (needle drop)**.
- **SHIFT modifier** (on-screen button + physical Shift key): remaps jog →
  loop-move, pads → save/clear loop, and transport (CUE→start, PLAY→from-cue,
  SYNC→pitch reset, KEY→channel reset).
- **Waveform**: continuously-zoomable LOD viewport, real-time x-axis (synced
  decks' grids line up), shared zoom, adaptive beat/bar/phrase grid, cue/loop
  markers, center-detent EQ knobs with dB/% readouts.
- **Library**: YouTube search / Explorer, playlist import, Collection +
  Playlists (localStorage), rekordbox-style track table.
- **Audio extraction**: VISIONOS Innertube client (direct URLs, no PoToken/
  cipher) + capped range chunking, **R2 cache** by videoId. Replaced ANDROID_VR on
  2026-08-24 when YouTube began PO-token-gating it past ~1 MB; a **residential
  relay** over a home tunnel is the cold-load fallback when the Worker's own
  egress trips the bot wall.
- **FX rack**: 9 always-armed devices per deck (EQ, COMP, DELAY, VERB, SAT, MOD,
  CRUSH, GATE, NOISE), pad-throwable, with **stem chains** — a chain claims some
  of the four stems and processes only those, so the stems stay a partition.
- **Preset banks**: user-arrangeable for every device *and* for chains — named
  sections, drag ordering, references to the shipped presets with tombstones and
  revert. 124 presets in 50 sections. Synced to the account with the MIDI maps,
  colour themes and keymaps; restore lives in Settings ▸ Audio.
- **Stems**: HT-Demucs, separated on a capable device and shared through R2 so
  phones download rather than compute. Per-device stem rendering; sliding-window
  OPFS paging keeps resident PCM under a byte budget.
- **Control surfaces**: USB-MIDI (DDJ-FLX4 + Donner Starrypad mapped, plus
  MIDI-Learn), an Xbox gamepad as a DJ surface, and a full keyboard map — all
  three saveable as shareable profiles.
- **Accounts + social**: Google/Spotify OAuth, cross-device settings + library
  sync (D1), shared live sessions (a Durable Object per room), profiles,
  following, notifications, and a moderation/DMCA console on a separate
  Access-gated Worker.
- **Auto-mix**, **smart fader**, **acoustic fingerprint ID**, **headphone cue**
  (2nd output via `setSinkId`), **mic / line capture with talkover ducking**, and
  **set recording**.
- **User YouTube auth**: **Sign in with Google** (OAuth 2.0 device-code flow —
  type a short code at google.com/device) to pass the "confirm you're not a bot"
  wall from the Worker's IP. Tokens live in the browser, auto-refresh, and are
  revocable from the user's Google account; never stored server-side. Pasting a
  raw cookie remains an Advanced fallback. Uses the public YouTube-on-TV client
  creds (no deployment secret); overridable via `wrangler secret`.
- **Persistence**: full session restores on refresh (loaded tracks via IndexedDB
  audio cache, mixer, zoom, per-deck controls, cues, loops, **play state**).
- **Theme + UX**: inky neon theme, settings (accent colors, glow), responsive
  three-section layout (tracks / decks+mixer / explorer) on desktop **and** a
  fit-to-iPhone mobile layout; double-tap / right-click to reset any knob/fader.
- **Deployed live** at https://handlingtheloop.com (Worker `htl` + R2 `htl-audio`).

---

## 🟡 In progress

**Stems on iOS, on-device.** Everything else about stems shipped; only the
on-device *GPU* path on iOS is disabled. Real iPhone 17 Pro Max / Safari
crash-and-reloads on the ORT 1.27 asyncify build for both models (WebKit
#304810 — Asyncify + JSC OMG-JIT). Only the **JSPI** build removes the trigger by
construction, and that needs iOS 27. Revisit then, not before. iOS still plays
stems separated elsewhere and shared via R2, which is the design.

**Lyrics / captions.** The YouTube caption ribbon works. Whisper transcription is
**on hold** after eleven attempts — read the top of the doc before reopening it.

**The 47 factory presets added on 2026-09-01** are authored from each device's
control ranges and its own header. They are **not measured and not ear-tested**.

---

## 🐛 Known bugs / things to verify on-device

- **iOS bottom-clip / Safari canvas quirks** — the waveform canvas is now pinned
  `position:absolute; inset:0`; verify no clipping on real iOS (Blink/headless
  can't reproduce WebKit here).
- **Resume-on-refresh audio** — state restores; sound resumes on the first tap
  (autoplay policy). Background playback on iOS is best-effort (no MediaSession
  yet — see roadmap); Web Audio can suspend when backgrounded/locked.
- **Cloud-IP `LOGIN_REQUIRED`** — fresh (un-cached) tracks fail to resolve from
  the Worker's IP unless the user connects a cookie; cached tracks always serve.
  This is the core ToS/arms-race risk of the serverless-only design.
- **Beatgrid** is mono onset-autocorrelation — prone to half/double-tempo on some
  material; SYNC inherits any error.
- **Keylock** is a light 2-tap pitch-shifter — soft at extreme pitch (±>10%).
- **Mobile density** — the full controller on a phone is tight by nature; banks
  can clip at the screen edge on the narrowest devices.

---

## 🧭 Roadmap

Everything the old version of this section listed under "near term" has shipped —
stems, FX, key detection, WSOLA time-stretch, recording. What is actually left:

**Near term**
- **Ear-test the 2026-09-01 preset banks.** 47 new presets went in unheard. They
  have now been MEASURED (the EQ bank's level spread is in docs/fx-rack.md and no
  preset is broken), but a measurement cannot say whether one sounds good.
- **MediaSession** — lock-screen controls and better background audio on mobile.
- **Touch coverage in draglab.** The suite drives a mouse; the 180 ms drag arm
  racing the 460 ms long-press menu is untested, and touch is where the menus are
  hardest.

**Engine / sound**
- **Beatgrid**: the tiered plan in `docs/`-adjacent notes — stem-cleaned onsets,
  then a Beat This! port, then a particle filter. SYNC inherits any grid error, so
  this is upstream of a lot.
- **Phase-vocoder** stretch is ear-tested and good but still opt-in behind WSOLA.
- **Cap-aware settings sync**: the account blob has a 256 KB server cap. A refused
  push now *reports* itself, but nothing measures the blob before pushing and
  there is no per-bank breakdown to tell you what to prune. (Measured 2026-09-01:
  the banks are 5.4 KB as references, 29.4 KB if every preset were edited — the
  growth vector is saved profiles carrying MIDI maps, not the banks.)

**Product**
- Cue-point / set export.
- WebGL waveform for very long mixes.
- Per-deck independent tempo range.

---

## 🏗️ Architecture (quick map)

```
worker/index.ts      CF Worker: serves the SPA + /api/*  (audio, search, stems,
                     analysis, accounts, social, community)
server/*             pure-JS resolver (youtube.ts = VISIONOS + range chunks, shared dev/prod)
src/htl/             the @htl internal library (path alias):
  audio/             AudioEngine, Deck, Eq3, the FX devices + worklets, fxPresets
                     (the preset/chain BANK engine), decode, trackCache
  analysis/          LOD pyramid, beatgrid, key, palette
  automix/           mixability scoring + the auto-DJ driver
  fingerprint/       Chromaprint → AcoustID → ISRC
  gamepad/ midi/     control surfaces (both feed one onMidiEvent path)
  media/             youtube source/api + OAuth headers
  library/           Collection + Playlists store (account-synced)
  persistence/       Store (versioned localStorage) + IndexedDB audio cache
  room/              shared-session protocol + client
  state/             settings, settingsSync (account LWW), session snapshot
  stems/             stem cache, separator worker, model registry
src/components/      React UI (DeckLane, DeckControls, FxStrip, WaveformViewport,
                     Explorer, TrackTable, LibraryPanel, SettingsPanel, …)
scripts/draglab/     headless-Chromium UI harness (menus, drag, sync) — see DEV.md
scripts/fxlab/       DSP measurement harness (real worklets, headless)
```

- `pnpm dev` (Vite middleware) and the Worker share the exact `server/*` resolver.
- `pnpm check` covers `src` **and** `server`/`worker` (`tsconfig.node.json`) plus
  the test suite. It is the gate `./deploy.sh` runs before touching the edge.
- **No secrets** in the repo: the player-client credentials are the well-known
  public YouTube-on-TV values (the same ones in yt-dlp / youtubei.js) and are
  overridable via Worker secrets. User OAuth tokens live in the user's browser and
  are forwarded per request, never persisted server-side.

## License

No license yet — all rights reserved by the author until one is added. (Add a
license before relying on this being open-source-usable.)
