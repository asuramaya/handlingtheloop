# The map — how Handling The Loop fits together

One read, end to end. Written 2026-09-01 against the tree; where a claim was
checked by running something, it says so.

The shape in one sentence: **a browser does all the work, and one Cloudflare
Worker does the two things a browser cannot** — reach YouTube without CORS, and
remember things across devices.

---

## 1. The layers

```
┌─ THE BROWSER ────────────────────────────────────────────────────────────┐
│  React UI            src/components  (77 files)                          │
│      ↕ spine + 7 concern hooks   src/App/                                │
│  Engine              src/htl/audio   AudioEngine ▸ Deck ▸ FxRack ▸ devices│
│  Analysis / DSP      src/htl/analysis, stems, lyrics   (workers)         │
│  Stores              localStorage ▸ IndexedDB ▸ OPFS                     │
└────────────────────────────┬─────────────────────────────────────────────┘
                             │ fetch / WebSocket
┌────────────────────────────┴─────────────────────────────────────────────┐
│  ONE WORKER   worker/index.ts → server/*  (pure JS, no binaries)          │
│    /api/audio      resolve + range-chunk + cache                          │
│    /api/me/*       accounts, settings, library  ── D1                     │
│    /api/room…      shared sessions             ── Durable Objects         │
│    R2 htl-audio    cached audio, stems, art, avatars, samples             │
└──────────────────────────────────────────────────────────────────────────┘
      a SECOND worker, admin.handlingtheloop.com, behind Cloudflare Access
```

**`server/*` is the seam that pays for itself.** It is pure JS with no `node:`
imports, so the *same* resolver runs as Vite middleware in dev and inside the
Worker in prod. `vite.config.ts` imports `handleApi` from `server/api.ts`; the
Worker imports the same modules. Dev and prod cannot drift on the part most likely
to break.

---

## 2. One track, end to end

The journey worth knowing, because almost every subsystem is on it.

```
 you type a search
   → /api/search            youtubei.js (cf-worker build), the stable browse endpoint
 you press A
   → /api/audio?v=ID        R2 hit? stream it.  miss ↓
                            VISIONOS Innertube client → a DIRECT stream url
                            (no PoToken, no cipher — that is why this client)
                            fetched in capped RANGE chunks, because a naive GET
                            of a googlevideo url is throttled to ~32 KB/s
                            → streamed to you AND written to R2 for everyone next
   → decodeAudio()          src/htl/audio/decode.ts → an AudioBuffer
   → analyzeTrackAsync()    a worker: LOD peak pyramid, beatgrid, key, palette
                            (cached in D1 by videoId — the second person to load
                            this track skips the analysis entirely)
   → deck.setBuffer()       the deck now has PCM and a grid
 you press ▶
   → source → stretch worklet → FxRack → trim → level → crossfader → master
```

**Separating stems forks that path.** `src/htl/stems` asks R2 first; on a miss, a
capable device runs HT-Demucs in a worker behind a concurrency-1 GPU queue (stems
and Whisper take turns), then uploads the result so nobody else pays for it.
Phones never separate — `canSeparate()` says no — they download. Afterwards the
deck runs **four synced sources** instead of one, and each stem can be claimed by
a different FX chain.

---

## 3. The engine

`AudioEngine` owns two `Deck`s, the crossfader, the master chain, and the
cross-deck wiring (sidechain taps, cue bus, mic).

A `Deck` (2.7k lines, the densest file in the app) owns: the source(s), the
stretch worklet, the `FxRack`, its analysis, cues, loops, and the jog.

```
Deck ─┬─ source | 4 stem sources
      ├─ stretch worklet        WSOLA by default, phase-vocoder opt-in
      └─ FxRack ─┬─ master chain   [EQ, COMP, DELAY, VERB, SAT, MOD, CRUSH, GATE, NOISE]
                 ├─ stem chain A   claims e.g. DRUMS      ─┐ parallel,
                 └─ stem chain B   claims e.g. VOCALS     ─┘ summed
```

Three rules hold the rack together, and breaking any one of them has caused a
real bug:

- **Membership is FIXED.** All nine devices are always resident, most of them
  dormant, so a pad throw never has to build a device mid-set.
- **Stems are a PARTITION.** A stem has exactly one owner. Taking it takes it from
  whoever had it, so nothing is heard twice and the chains sum back to the track.
- **Params ride PORT MESSAGES, never AudioParams.** iOS Safari kills a worklet
  whose `parameterDescriptors` fail to register. This is project-wide.

Devices implement one contract (`FxDevice`: input/output, bypass, a
string-addressed param bus) — which is the single seam that session-sync, the
auto-mixer, MIDI and the preset banks all address. See
**[fx-rack.md](./fx-rack.md)**.

---

## 4. Where state lives

Four stores, and the split is deliberate.

| Store | Holds | Why there |
|---|---|---|
| **localStorage** | settings, preset banks, library, sampler regions, UI state | read **synchronously** during render and from the hardware preset browse — neither can await |
| **IndexedDB** | decoded audio | too big for localStorage; survives a refresh so the session restores with sound |
| **OPFS** | stem working files | worker-accessible, large |
| **D1** (server) | accounts, settings blob, library blob, social graph, rooms, analysis, lyrics, captions, community index, moderation | 28 tables; the cross-device truth |
| **R2** (server) | audio (`a/${videoId}`), stems, album art, avatars, samples, recorded sets | big binaries, edge-served |

**The client is the source of truth; the server is a mirror.** Settings and
library sync as **last-write-wins blobs** stamped by the client
(`htl:settingsUpdatedAt`), reconciled on load and pushed debounced. That is cheap
and total-order-free, and its two sharp edges are both real:

- the blob is capped at **256 KB** server-side, and a refused push used to be
  swallowed silently (it now reports — Settings ▸ Audio). Measured 2026-09-01: a
  live blob is 1.3 KB, all ten preset banks add 5.4 KB as references and 29.4 KB
  if every preset were edited. The banks are bounded; **saved profiles carrying
  MIDI maps are not** — that is the growth vector to watch.
- an inbound blob must be written **down** into localStorage, not just into React
  state, and it always arrives *after* mount. Getting that wrong destroyed a
  second device's curation, silently, in both directions.

---

## 5. The two sync planes

They are different and it matters.

**Account sync** — durable, slow, last-write-wins, over `/api/me/*` into D1. Your
settings, banks, maps, themes, library. Reconciled on sign-in, then a 30 s poll as
a backstop under the live nudge.

**Session sync** — live, per-room, over a WebSocket into a **`DjRoom` Durable
Object**. Not a shared state blob: a stream of **intents** (28 kinds — control,
load, seek, queue, sample, …) plus periodic snapshots and playhead ticks.

- The **anchor is authority**, not "the controller" — whoever holds it decides the
  playhead; everyone else follows and corrects drift.
- Your **own devices** are a silent control-extension of one rig; visiting someone
  else's rig is an `attach()` with snapshot/restore at the boundary.
- **Going live** promotes the room to a broadcast; past ~500 listeners a
  `RelayRoom` crowd-shard tier fans out instead (validated to N=1000).

See **[shared-session.md](./shared-session.md)** — its *header* is stale (it says
phases 2–3 are unwired; they shipped) but its body is the protocol.

---

## 6. Control surfaces

Four ways to drive the same deck, and they deliberately converge early:

```
keyboard ─┐
MIDI ─────┼─→ one onMidiEvent path → the same actions the UI buttons call
gamepad ──┘
touch/mouse → the UI
```

MIDI-Learn, the FLX4 and Starrypad profiles, the gamepad, and the keymap all save
as **shareable profiles** synced with your account. The hardware has traps worth
knowing before you touch it — see **[ddj-flx4.md](./ddj-flx4.md)**.

---

## 7. Threads

Not everything is on the main thread, and the boundaries are load-bearing:

| Thread | Runs |
|---|---|
| main | React, the UI, the engine graph *wiring* |
| AudioWorklet | stretch, comp, saturator, crush, mod-delay, reverb FDN — the real-time DSP |
| Web Worker | analysis (beatgrid/key/palette), stem separation, lyrics alignment |
| Durable Object | one per live session, server-side |

Cross-origin isolation (COOP/COEP) gates threaded stem separation, which is why it
needs `run_worker_first` + `credentialless` on the edge, and why separation is
off over plain-HTTP LAN dev while everything else still works.

---

## 8. Where to start reading

- **the whole client** → `src/App.tsx` (3.7k) then `src/App/spine.ts`
- **sound** → `src/htl/audio/AudioEngine.ts` → `Deck.ts` → `Fx.ts`
- **an effect** → any `src/htl/audio/*Fx.ts`; the file header is the design doc
- **the FX UI** → `src/components/FxStrip.tsx` (menus, banks, drag)
- **getting audio** → `server/youtube.ts` (read the comment block above
  `VISIONOS_VERSION` — it is the arms race, written down)
- **playing together** → `src/htl/room/protocol.ts` then `server/room.ts`
- **testing the untestable** → `scripts/draglab/` (see [DEV.md](../DEV.md))

The comments in this codebase are the primary documentation and are written to
carry the *why*, including the dead ends. When a comment and a doc disagree,
**believe the comment** — and then fix the doc.
