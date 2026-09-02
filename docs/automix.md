# The auto-mixer — a DJ that expects you to interrupt it

`src/htl/automix/` (2.9k lines). The gesture that shares its DSP is documented in
[smart-fader.md](./smart-fader.md); this is the machine.

## The premise

It is **not an autopilot with a human override bolted on**. It drives the same
engine and deck controls the UI buttons drive, and assumes you will jog, scratch,
load or grab the crossfader mid-transition. Two consequences run through the whole
design:

- **Every tick re-checks reality** (`reconcile`) rather than trusting its own plan.
- **The transition runs on wall-clock playing time, not the playhead** — so
  scratching a deck cannot scramble the fade.

Grab the fader mid-mix and it enters `manual` and stands back until one deck is
left. That is a first-class phase, not an error path.

## The machine

```
idle → armed → preload → cueing → mixing → settle → (armed) …
                                     ↘ manual  (you took the fader)
```

`preload` is eager on purpose: the next track loads *and separates* when the
current one starts, because a stem separation cannot be started at the mix point
and finish in time.

## The parts

| File | Owns |
|---|---|
| `autoMixer.ts` | the state machine and the transition execution |
| `mixability.ts` | `pickTransition` — whether and how two tracks can meet |
| `queue.ts` | the mix queue (host-authoritative in a session; remotes send intents) |
| `smartFader.ts` | the hand-driven version, same DSP |
| `usePrefetch.ts` | the eager next-track load |
| `types.ts` | `AutoMixPhase`, `MixMode`, `TransitionPlan` |

Four test files — the machine, mixability, the queue and the fader — because the
decisions are pure and the execution is not.

## What it decides

- **Tempo** — folded by octave (`foldTempoOctave`) before comparison, so a 140 and
  a 70 are a match, not a mismatch. This directly inherits the beatgrid's
  half/double-tempo confusion; see [analysis.md](./analysis.md).
- **Key** — Camelot adjacency.
- **Where** — phrase-anchored mix points from the analysis, with a first-sound /
  last-sound trim so it does not fade into silence, and `END_GUARD` (4 s) so it
  never starts a mix that cannot finish.
- **How** — the plan crossfades, morphs tempo, and swaps bass with an EQ kill at
  `EQ_KILL` (−26 dB, the engine's low-shelf floor).

## In a shared session

The queue is **host-authoritative**. Remotes do not mutate it; they send
`{kind:"queue"}` intents and the host applies them, which is what lets the queue
survive an anchor handover. Adds, removes and moves are all id-based rather than
index-based — an index means something different on each device the moment anyone
edits.
