# The auto-mixer — a DJ that expects you to interrupt it

`src/htl/automix/` (~4.5k lines). The gesture that shares its DSP is documented in
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
| `selector.ts` | **which track plays next** — scoring, artist cooldown, the energy arc |
| `mixability.ts` | `pickTransition` / `resolveStyle` — whether and how two tracks can meet |
| `mixPoints.ts` | **where** the mix happens, from the track's section structure |
| `queue.ts` | the mix queue + the candidate pool (host-authoritative in a session) |
| `smartFader.ts` | the hand-driven version, same DSP |
| `usePrefetch.ts` | the eager next-track load |
| `types.ts` | `AutoMixPhase`, `MixMode`, `TransitionPlan`, `RadioContext`, `EnergyArc` |

Test files per module, because the decisions are pure and the execution is not.

### `selector.ts` vs `mixability.ts`

These answer different questions, and conflating them was a real bug for a long time:

- `mixability(a, b)` — *if these two play back to back, how well do they MEET?*
  Drives the transition planner and the UI badge. It deliberately returns a
  **neutral 0.5** for an unknown key or tempo, because an unanalysed track should
  not be punished when you are only describing a transition.
- `scoreCandidate()` — *given everything about this moment, SHOULD this be next?*

The old code used the first for the second and inherited that neutral as a bug:
fresh radio candidates essentially never carry analysis, so the term was a
constant across the whole pool, the harmonic contribution cancelled out, and
ranking silently collapsed to raw provider order. In the selector, unknown is its
own state — it contributes nothing *and* forfeits the analysed bonus.

## Where the next track comes from

**Radio is the default.** "Playlist" is what you opt into by choosing one; an
empty load falls back to radio, because a fixed, empty, never-refilling source is
a state AUTO cannot do anything with.

Two **stable** seeds — the vibe `anchor` (the track the user last chose by hand,
decaying with age) and what is currently playing — feed a standing **pool** of
~60 scored candidates. The visible queue draws from the pool one track at a time
when it runs short.

This replaced a scheme that seeded from a 3-wide sliding window over recent plays
and rebuilt the entire upcoming tail every song. That window moved by one each
track, so two of three seeds were always unchanged and the candidate pools
overlapped about two thirds — and results were merged by *summing* relatedness
across seeds, which explicitly promoted whatever the radios had in common. It
amplified its own repetition by design.

Server side, `/api/recommend` runs three tiers, best first (see
`server/recommend.ts`): TIDAL track radio → **YouTube Music radio** (`RDAMVM`) →
the YouTube watch-next spine. The music-radio tier is new and carries most of the
load: measured against the same seed it returns ~33 candidates to watch-next's
~6, and it is a *sequence* rather than a click-optimising surface.

## What it decides

- **Tempo** — folded by octave (`foldTempoOctave`) before comparison, so a 140 and
  a 70 are a match, not a mismatch. This directly inherits the beatgrid's
  half/double-tempo confusion; see [analysis.md](./analysis.md).
- **Key** — Camelot adjacency.
- **Where** — phrase-anchored mix points from the analysis, with a first-sound /
  last-sound trim so it does not fade into silence, and `END_GUARD` (4 s) so it
  never starts a mix that cannot finish.
- **Where** (structure) — `mixPoints.ts` reads the rekordbox-style A/B/C/D repeat
  labels the analysis puts on the beatgrid. The most-repeated label is the hook, so
  the mix-out prefers the *end of its last repeat*; the first label that recurs is
  where the track really starts, so the mix-in lands it at the end of the blend.
  Blend length is fitted to the section actually available and quantised to a real
  phrase.
- **How** — one of ten gestures (`resolveStyle`), plus an orthogonal `loopExtend`
  that holds the outgoing on a 4-bar loop when the incoming needs more runway.
  Availability is a runtime question, and the picker declines to repeat the
  previous gesture when it has a comparable alternative.

| Gesture | What it does | Needs |
|---|---|---|
| `blend` | EQ3 crossfade, bass swap | — |
| `filter` | one-knob HP/LP sweep | — |
| `cut` | quick change | — |
| `stemswap` | 4-stem arrangement handover | **both decks separated** |
| `echoOut` | tempo-synced delay throw, frozen on the tail | FX rack |
| `washOut` | reverb swell, dry pulled out under it | FX rack |
| `gateChop` | synced gate, depth ramping, 1/8 → 1/16 | FX rack + grid |
| `loopChop` | loop halves 1 bar → ½ → 1 beat under a climbing filter | grid |
| `dropSwap` | outgoing collapses, hard cut to the incoming's body | grid + body section |
| `spinOut` | spinback into the incoming's "1" | grid |

★ **Only `stemswap` needs stems.** Separation is optional and often late, so the
gestures that carry the character run off the channel FX and the loop engine —
both of which every deck always has. A track that never gets separated still gets
an interesting transition.

★ **The FX bank is free.** Every deck permanently carries delay, reverb, saturator,
crush, mod, gate and noise (`Deck.PERMANENT_KINDS`), each dormant: bypassed, wet
pruned, zero CPU. The auto-mixer never adds a device — it borrows one, and returns
it with every param and its bypass exactly as found. An earlier version gated
`echoOut` on the user happening to keep a delay on the channel, which was simply
wrong about the rack and made the best-sounding transitions the rarest ones.
- **How loud** — every deck is trimmed to a fixed reference (`gainTrim`) so the set
  sits at one level. AUTO never fights a hand on the knob and hands every channel
  back at unity when switched off.

## The stem race

Whether the incoming track is separated **by mix time** is a genuine race, and
resolving it once at `startMix` was wrong in both directions. `raceStems()` runs
every mixing tick:

- **Upgrade** `blend → stemswap` when separation lands mid-blend — but only
  *before the bass swap begins*. After that the low end is already part-way across
  on the EQ path and switching would jump it; before it, both paths agree the
  incoming has no bass yet, so the change is inaudible.
- **Degrade** `stemswap → blend` the instant either deck loses stems (mobile drops
  buffers under memory pressure). Stem gains are handed back immediately — a
  half-applied stem mix left in place means two low ends at once.

A 24-bar blend at 128 bpm is 45 seconds, which is easily long enough for a
separation to finish inside it.

## What AUTO borrows, and gives back

The auto-mixer drives the user's decks, so everything it builds for a transition
is torn down on **every** exit path (settle, cancel, hand-off to manual, disable):

| Borrowed | Given back |
|---|---|
| channel trim | restored to unity — unless the user moved it, which wins permanently |
| any device from the permanent FX bank | every param and its bypass state |
| an **ephemeral** per-stem chain (the vocal tail) | chain removed, the claimed stem returned to its previous owner |
| a beat loop (`loopExtend`, the drop-swap roll) | `exitLoop` — a deck left looping never ends |

`FxChain.ephemeral` is the mechanism for the third: the chain is real and audible,
but excluded from `fxChainSnapshot()`, so it can never be saved into a profile or
mirrored to a session. It also *survives* `applyFxChainSnapshot` — a remote's
routine rack update must not rip out the chain a live blend is running through.

### Visible, but not yours to edit

That chain shows up in the FX strip while a transition runs, badged and marked as
AUTO's. It is deliberately **read-only**: no reorder, no stem re-routing, no
presets. Not to lock you out — because there is nothing durable there to edit. It
exists for twenty to forty seconds and is destroyed at settle, so a change would
be gone before you finished making it, and making it *stick* would mean AUTO
diffing your input against its own ramps every tick and arbitrating each param
mid-blend. That is real complexity for a window that closes almost immediately,
and its failure mode is you and the machine fighting over a knob during a mix.

So the recipe is the editable thing: **Settings ▸ Controls ▸ Auto-DJ FX tail**
(`settings.autoFx` — effect, stem, wetness). AUTO stamps a fresh instance from it
at the start of every transition, so an edit lands on the next mix with nothing to
reconcile. You own the recipe; AUTO owns the twenty seconds.

And "I want to intervene *right now*" already has a better answer than editing a
doomed chain: grab the crossfader, and the mixer enters `manual` and hands
everything it borrowed straight back.

★ Anything claiming a stem must go through `setChainStems`, **not** `addChain`'s
mask argument: only the former enforces one-owner-per-stem, and two chains holding
the same bit makes the rack play that stem twice.

## What is NOT on a dial

Settings ▸ Controls ▸ **Auto-DJ performance** (`subtle` / `standard` / `showy`)
governs *flourish only* — a treble lift as the incoming takes the lead, a hot cue
parked on its drop, a gate stutter, a spinback. The structural work (beatmatch,
bass swap, gain staging, mix points) is never optional. It is a taste control, not
a quality one.

## In a shared session

The queue is **host-authoritative**. Remotes do not mutate it; they send
`{kind:"queue"}` intents and the host applies them, which is what lets the queue
survive an anchor handover. Adds, removes and moves are all id-based rather than
index-based — an index means something different on each device the moment anyone
edits.
