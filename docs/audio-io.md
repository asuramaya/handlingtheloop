# Audio I/O — samplers, recorders, mic, and outputs

The map of how sound gets *in* (mic, captures), gets *sliced* (sampler), and gets *out* (master/PA,
headphone cue, second device). Source of truth: `src/htl/audio/` (`AudioEngine`, `Sampler`,
`MicInput`, `Recorder`, `ringRecorderWorklet`) + `src/components/useSampler.ts`.

## Signal flow

```
                      mic sidechain dips musicBus.gain
                                   │
 deck A ─(EQ/filter/fader)─┐       ▼
 deck B ─(EQ/filter/fader)─┼─→ musicBus ──────────────┐      global sampler pads ──┐
 region sampler pads ──────┘   (rests at 1)           │      (cut through)         │
                                                       └─→ master ─→ limiter ─→ ctx.destination ─→ PA
 mic talkover ──────────────────────────────────────────→ master      (−3 dB / 20:1)   (setSinkId)
                                                           │
 deck pre-fader cueSends ─┐                   (master tap)─┘
 mic monitor (PFL) ───────┴─→ cueMaster ─→ cuePflGain ─┐
                                                       ├─→ cueOut ─→ MediaStreamDest ─→ <audio>.setCueSinkId ─→ 2nd device
                              master tap ─→ cueMasterSend ┘   (level)
```

`cuePflGain` / `cueMasterSend` are the two sides of the **CUE↔MST** constant-power blend; `cueOut.gain`
is the headphone master level.

## Samplers — 24 pads, 3 banks (`useSampler.ts`)

| Bank | Pads | Source | Routes to | Storage / sync |
|---|---|---|---|---|
| **Global** | 0–7 | Uploaded files **or** captured clips | **Master** (un-ducked, cuts through) | Account-stored (D1 + R2); syncs across your devices; guests fetch via the room-membership gate (#48) |
| **Deck A region** | 8–15 | A slice of deck A's loaded track | **Deck A channel** (EQ/filter/fader/crossfader + tempo-sync) | Positions in localStorage per-videoId; synced to guests as positions — they replay off their own copy (no audio on the wire) |
| **Deck B region** | 16–23 | Same, for deck B | **Deck B channel** | Same |

Per-pad: **mode** (`oneshot` · `gate` · `loop` · `bounce`), **gain**, **pitch** (semitone varispeed),
and for region pads a **stem chop** (one of drums/bass/vocals/other, or full mix — desktop only,
needs resident neural stems). Region capture grabs the active loop if set, else 1 bar from the playhead.

## Recorders — capture → Take → pad (`Recorder.ts`, `ringRecorderWorklet.ts`)

- **Recorder (tap):** points at any node — a deck output, the mic tap, or the master feed —
  `setSource(node)` → `MediaStreamDestination` → `MediaRecorder` (opus/webm) → `stop()` decodes to an
  AudioBuffer **and** re-encodes to **WAV** (opus only decodes on Chromium; WAV reloads everywhere).
  `start(maxSec=30)` auto-stops.
- **Master ring** ("grab what just happened"): `ringRecorderWorklet` holds a rolling **24 s** circular
  buffer on the master; a `grab` message dumps the last N seconds *retroactively*. The node is always
  pulled (its silent output stays wired toward the destination) so the ring stays fresh.
- A **Take** = `{ decoded buffer, WAV blob }`; captures land on the next free **global** pad.

## Mic — live input (`MicInput.ts`)

`getUserMedia → HPF → level →` three taps:
- **Talkover** → master, with an **audio-rate sidechain auto-duck** (mic envelope → `|x|` → LP ~12 Hz →
  −depth → `musicBus.gain`; depth 0–1, default 0.6). Lands on **master** (PA, auto-duck on) / **A** / **B**
  (into a deck channel — no auto-duck there, or the mic would duck itself).
- **Monitor (PFL)** → the cue bus (hear yourself in the 'phones).
- **Recorder tap** → feed the Recorder to make a pad clip.

## Outputs — routing + devices (`AudioEngine.ts`)

- **Master → PA:** `musicBus + global pads + mic → master → limiter (−3 dB, 20:1) → ctx.destination`.
  `setSinkId(deviceId)` routes the whole context to a chosen device (Chromium/Edge: `AudioContext.setSinkId`).
- **Headphone CUE / PFL (2nd device):** deck **pre-fader** cueSends + mic monitor → `cueMaster`; a tap of
  `master` → `cueMasterSend`; both blend into `cueOut` → `MediaStreamDestination` → hidden `<audio>` →
  `setCueSinkId`. `setCueMix` (constant-power CUE↔MST), `setCueLevel` (headphone level). Pre-fader means
  you can cue a deck that's faded all the way out.
- **iOS background audio:** `enableBackgroundAudio()` — same MediaStream→`<audio>` bridge keeps sound
  alive when backgrounded.

## Platform asterisks

- **Stem-chop / live-blend region pads → desktop** (need resident neural stems).
- **Output-device picking + the 2nd-device cue → Chromium/Edge** (`setSinkId`).
- **Mic → secure context** (HTTPS / localhost) + a user gesture for `getUserMedia`.

## Not built / known gaps

- **#58 live-blend region capture** — bake the *current* stem mix into a pad. Needs an offline render to
  a baked buffer (can't be a position pointer), so it'd be session-only / non-syncing / desktop-only.
