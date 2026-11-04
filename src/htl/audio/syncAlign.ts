// WHERE A SYNCED DECK SHOULD START, so it starts IN PHASE.
//
// Operator, 2026-11-03: "i did notice sync problems when using sync/master". SYNC aligned the pair's
// phase exactly once, on engage. Anything after that left the phase to the phase-lock loop, which is
// gentle by design (~8 s time constant, eleven seconds to clear a quarter beat, decision bb250621):
//   • engage SYNC with the follower paused at its cue → the master keeps playing, so when you press
//     play the follower starts some random fraction of a beat off and flams for seconds;
//   • a hot cue / cue jump / seek while synced → same, from wherever it landed;
//   • the master started while the follower is already playing → the pair starts out of phase.
// A CDJ starts a synced deck in phase. This is that: when a deck in a SYNC pair STARTS (play) or
// JUMPS while playing, and the other deck is playing, move the start to the nearest point that is in
// phase with the other deck. The move is at most half a beat, it happens at the start or the jump
// itself (so there is nothing to hear being corrected), and the phase-lock loop then only has to
// hold a pair that is already locked, which is what it is good at.
import { beatPhase, commonPhaseError, type Beatgrid } from "../analysis/analyze";

export interface AlignSide {
  grid: Beatgrid;
  pos: number; // seconds into the track
  rate: number; // effective playback rate (tempo × trim)
}

/** The position nearest `self.pos` whose beat phase matches `other`'s right now. `fold` handling
 *  (a half/double-time pair) is commonPhaseError's: the phase is compared at the audible beat.
 *  Never moves more than half a beat; returns `self.pos` unchanged when the grids are unusable. */
export function phaseAlignedStart(self: AlignSide, other: AlignSide): number {
  const sg = self.grid;
  const og = other.grid;
  if (!(sg.interval > 0) || !(og.interval > 0) || !(sg.bpm > 0) || !(og.bpm > 0)) return self.pos;
  const fold = other.rate > 0 ? (self.rate * sg.bpm) / (other.rate * og.bpm) : null;
  const ratio = fold != null && fold > 0 ? Math.pow(2, Math.round(Math.log2(fold))) : 1;
  // The audible beat on SELF's side, in self's track seconds (commonPhaseError lifts the coarser grid).
  const scaleSelf = ratio < 1 ? Math.min(8, Math.round(1 / ratio)) : 1;
  const audibleInterval = sg.interval / scaleSelf;
  const target = beatPhase(og, other.pos);
  let pos = self.pos;
  // Two passes: the first uses the average interval; the second corrects for a dynamic grid's local
  // spacing at the new spot. Each is a small move; the sum stays within half a beat.
  for (let i = 0; i < 2; i++) {
    const err = commonPhaseError(beatPhase(sg, pos), target, fold);
    if (Math.abs(err) < 1e-4) break;
    pos -= err * audibleInterval;
  }
  if (Math.abs(pos - self.pos) > audibleInterval * 0.6) {
    // a grid oddity pushed it further than the nearest in-phase point can be: do not move at all
    return self.pos;
  }
  return Math.max(0, pos);
}
