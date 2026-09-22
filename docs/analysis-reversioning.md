# What bumping ANALYSIS_VERSION actually costs

Four detector findings are in front of the operator (the offbeat grid flip, the 174 bpm half-speed
fold, the 23 ms constant bias, and the "smoother errors buy as much as smaller ones" result). All
three of the first ones need beat detection changed, and changing it invalidates every grid in the
shared pool. This is the cost of that, sketched **before** the answer rather than discovered after —
so the decision is made with its bill attached.

Nothing here is a proposal to do it. It is what would happen if we did.

## There is no batch migration, and that is by design

`track_analysis` already converges monotonically and lazily, and both halves of the mechanism exist:

- **The client refuses what is behind it.** `mayReuseGrid` (src/App/gridReuse.ts) reuses a pooled grid
  only when `stored.version >= ANALYSIS_VERSION`. Bump the constant and every existing row is
  instantly "behind", so the next load of that track derives locally instead.
- **The server refuses to go backwards.** `putAnalysis` (server/db/analysis.ts) writes only
  `WHERE excluded.version >= track_analysis.version`, and the grid/palette/energy follow-up updates
  carry the same guard. A stale client cannot overwrite a newer row.

So the "migration" is: change the number, ship, and the pool upgrades one track at a time as people
play them. No backfill job, no downtime, no coordinated cutover. Untouched tracks keep their old
grids indefinitely, which is correct — nobody is waiting on them.

## The bill, per track, paid once

Measured on this machine (desktop, Node, single-threaded, synthetic 128 bpm material):

| track length | `detectBeatgrid` | full `analyzeTrack` |
|---|---|---|
| 3 min | 431 ms | 801 ms |
| 5 min | 661 ms | 1366 ms |
| 7 min | 976 ms | 1634 ms |

It runs in a worker (`analysis.worker.ts`), so it is off the main thread, and it already happens for
every track nobody has contributed yet — this is not a new code path, it is the existing one running
more often for a while. On a phone at ~4x slower, a 5-minute track is ~5.5 s of background work on
its first load after the bump. The user-visible effect is that the beatgrid appears later than usual,
once per track.

## The seam that is NOT already handled

**Two clients in one room can hold different grids for the same track, and some intents are
denominated in BEATS.**

`protocol.ts` mixes two units deliberately. Transport and cue carry seconds (`pos`, `position`), but
`{ kind: "skip"; deck; beats }` and `{ kind: "loop"; …; beats }` carry beats, and the receiver
resolves them against **its own** beatgrid. That is right when both sides agree about the grid.
During a rollout they may not:

- Client on the NEW version, pool row still OLD → it refuses the row and derives locally. Its grid is
  the new detector's.
- Client on the OLD version, pool row already NEW (someone else upgraded it) → `5 >= 4` passes, so it
  **accepts** the newer grid. This direction is fine, and is the pool doing its job.
- The two together: an old client using the cached old grid beside a new client that re-derived. A
  4-beat jump then lands at a different absolute time on each, and a beat-length loop is a different
  length. The periodic seconds-denominated position anchor re-converges them, so this is divergence
  between anchors rather than permanent drift — but it is audible divergence on exactly the gesture
  a DJ uses most.

This is a seam between the pool (mine) and the room layer (Metron's) and neither of us has mapped it
before now. Two ways out, both cheap, neither taken here because a protocol change needs both names
and the operator:

1. **Resolve beats to seconds at the sender.** The driver already knows its own grid; send the
   absolute destination alongside the beat count and let the receiver prefer it. Smallest change,
   removes the class rather than detecting it.
2. **Carry the grid version in the room's track-load message** so a peer can at least *know* it
   disagrees. Detects, does not fix.

## Checked and NOT a problem

- **Saved cues and loops are in seconds, not beat indices.** `DeckSnapshot` carries `cuePoint`,
  `hotCues`, `hotLoops`, `loop`, `loopInPoint`, all as playhead positions. A new grid does not move
  anyone's cues.
- **Published sets store absolute `at` timestamps** in their tracklist, so a re-analysed track does
  not disturb a set that has already been published.
- **`energy` travels with `bpm`.** It is derived partly from tempo (`paceFromBpm`), and both are
  written in the same `postAnalysis` call under the same version guard, so a row can never hold a new
  bpm with an old energy. Auto-mix candidate scoring WILL shift for re-analysed tracks — correctly,
  but noticeably, and worth saying out loud rather than discovering as "the radio feels different".
- **A client holding an old grid mid-session is unaffected.** Grids are read once per load; nothing
  re-reads the pool under a playing deck.

## What this does not tell you

How much real music any of the four findings actually affects. Every one of them is measured on
synthetic material — mechanism and threshold, not frequency. A handful of the operator's own tracks,
or one session recording, is the thing that would turn "this can happen" into "this is happening to
you", and it is the cheapest next measurement available in this whole area.
