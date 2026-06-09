# htl — Status, Known Issues & Roadmap

A living inventory of what works, what's half-built, what's broken, and where this
is going. Companion to the [README](./README.md).

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
- **Audio extraction**: ANDROID_VR Innertube client (direct URLs, no PoToken/
  cipher) + 1 MB range chunking, **R2 cache** by videoId.
- **User YouTube auth**: paste your own cookie to pass the "confirm you're not a
  bot" wall from the Worker's IP (SAPISIDHASH); never stored server-side.
- **Persistence**: full session restores on refresh (loaded tracks via IndexedDB
  audio cache, mixer, zoom, per-deck controls, cues, loops, **play state**).
- **Theme + UX**: inky neon theme, settings (accent colors, glow), responsive
  three-section layout (tracks / decks+mixer / explorer) on desktop **and** a
  fit-to-iPhone mobile layout; double-tap / right-click to reset any knob/fader.
- **Deployed live** at https://handlingtheloop.com (Worker `htl` + R2 `htl-audio`).

---

## 🟡 In progress — Stems (mobile-first)

The **infrastructure is built and live**; the model inference + playback are the
remaining integration (needs a real device to verify — can't run WebGPU/audio or
fetch a ~40 MB model in CI).

- **Done:** `/api/stems` R2 cache (GET manifest / GET stem / PUT stem); the
  `@htl/stems` client (`getStems` cache-first flow, `canSeparate()` capability
  gate, Opus-encode-via-MediaRecorder upload). The mobile workaround = **separate
  once on a capable device (WebGPU / desktop), share via R2; phones download**.
  onnxruntime-web + the model load from a **CDN, lazily, only on capable
  devices** — never bundled, never on phones.
- **Left to do (needs device + a hosted model):**
  1. Wire the real ONNX inference in `separateOnDevice` (it currently throws):
     `InferenceSession` from a hosted HT-Demucs ONNX export, webgpu→wasm,
     ~7.8 s chunked overlap-add, `[1,2,N] → [1,4,2,N]`.
  2. Host `htdemucs.onnx` (a quantized export) at `/models/` or a CDN.
  3. **Stem-aware Deck**: 4 synced `AudioBufferSource`s → per-stem `GainNode`s →
     the existing pitch/EQ/filter chain (keep the single-source path identical
     for N=1).
  4. **StemMixer UI**: per-stem volume / solo / mute, an enable/disable toggle,
     and the **4 stems drawn layered** in the waveform viewport.

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

**Near term**
- Finish **stems** (inference + stem-aware deck + StemMixer + layered waveform).
- **MediaSession** integration (lock-screen controls + better background audio).
- **Consent / access gate** before promoting publicly (ToS-honest flow).
- A guided "**how to copy your YouTube cookie**" helper in Settings.

**Engine / sound**
- **WSOLA / phase-vocoder** or WASM (SoundTouch / RubberBand) time-stretch for
  rekordbox-grade keylock.
- Better **beatgrid** (spectral-flux onsets + downbeat), manual grid nudge.
- **FX** (filter is done; add echo / reverb / roll), musical **key detection**
  (fill the Key column + key-sync).

**Product**
- Recording / export of a set; cue-point export.
- WebGL waveform for very long mixes.
- Per-deck independent tempo range.

---

## 🏗️ Architecture (quick map)

```
worker/index.ts      CF Worker: serves the SPA + /api/{audio,search,playlist,meta,stems}
server/*             pure-JS resolver (youtube.ts = ANDROID_VR + range chunks, shared dev/prod)
src/htl/             the @htl internal library (path alias):
  audio/             AudioEngine, Deck, Eq3, decode, trackCache, pitchWorklet
  analysis/          LOD pyramid + beatgrid
  media/             youtube source/api + user-auth (cookie) headers
  library/           Collection + Playlists store
  persistence/       Store (versioned localStorage) + IndexedDB audio cache
  state/             settings + session snapshot
  stems/             stem cache + (pending) on-device separation
src/components/       React UI (DeckLane, DeckControls, ChannelStrip, Knob, Fader,
                      WaveformViewport, Explorer, TrackTable, LibraryPanel, SettingsPanel)
```

- `pnpm dev` (Vite middleware) and the Worker share the exact `server/*` resolver.
- `pnpm typecheck` covers `src` **and** `server`/`worker` (`tsconfig.node.json`).
- **No secrets** in the repo: the ANDROID_VR client is public config; YouTube
  cookies are user-supplied at runtime and never persisted server-side.

## License

No license yet — all rights reserved by the author until one is added. (Add a
license before relying on this being open-source-usable.)
