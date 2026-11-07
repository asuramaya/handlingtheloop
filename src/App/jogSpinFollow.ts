// AFTER THE HAND LEAVES A NON-MOTORIZED JOG, THE PLATTER IS STILL THE RECORD.
//
// The DDJ-FLX4's platter has real inertia and no motor. Measured on the operator's unit
// (decision 8283a6e8): after a release it keeps spinning free for 0.4–0.9 s, and 4 s after a hard
// fling, sending hundreds to 2,000+ CC 0x21 ticks at a median 2× and up to 27× realtime. Those
// used to be routed to the pitch BEND (a warble after every scratch on a playing deck) or to a
// needle SEEK (the playhead jumped on a paused one), while JogEngine ran its own SIMULATED coast
// from the hand's last velocity. Two things moved the audio at once, and only one was real.
//
// Operator, on whether to ignore the spin: "im not sure that its ignored because the spinback is
// physical and there is a sense of momentum while the spin spins after release". So the spin is
// FOLLOWED: the grab stays alive past the touch-up, the free-spin ticks keep driving the platter
// position, and the deck is handed back only once the physical platter has settled. The momentum
// you feel is then the platter's own, and a backward fling really spins back before the motor
// catches it. This function is the "settled yet?" rule, pure so it is testable without hardware.

export interface SpinFollowInput {
  /** The deck was playing when gripped, so a handoff spins back up to play (else it rests). */
  returnsToPlay: boolean;
  /** The platter's smoothed velocity, track-seconds per second, signed (1 = play speed at rate 1). */
  vel: number;
  /** The deck's set play rate (the tempo the motor catches back to). */
  rate: number;
  /** Milliseconds since the last free-spin tick arrived. */
  msSinceTick: number;
  /** Milliseconds since the touch-up that started the follow. */
  msSinceRelease: number;
}

export type SpinFollowAction = "follow" | "handoff";

/** No tick for this long: the platter has stopped turning. At 720 ticks/rev, 60 ms without one is
 *  slower than ~0.06× play speed, i.e. effectively still. */
export const SPIN_STILL_MS = 60;
/** Hard cap so a runaway spin (or a lost touch-up) can never hold the deck indefinitely. Longer
 *  than the longest measured free spin (~4 s after a hard fling). */
export const SPIN_MAX_MS = 6000;
/** A backward spin is "nearly stopped" below this fraction of play speed, where the motor catches
 *  it. Small enough that the physical spinback is heard, not cut short. */
export const SPIN_CATCH_FRACTION = 0.08;

export function decideSpinFollow(i: SpinFollowInput): SpinFollowAction {
  if (i.msSinceRelease >= SPIN_MAX_MS) return "handoff";
  if (i.msSinceTick >= SPIN_STILL_MS) return "handoff"; // the platter has stopped
  if (i.returnsToPlay) {
    const rate = Math.max(0.05, i.rate);
    // Forward and down at (or under) play speed: play continues from here without a seam.
    if (i.vel > 0 && i.vel <= rate) return "handoff";
    // Backward (a spinback) that has nearly stopped: the motor catches it from here.
    if (i.vel <= 0 && -i.vel < SPIN_CATCH_FRACTION * rate) return "handoff";
  }
  // Paused decks follow until the platter stops (covered above). Playing decks keep following a
  // spin that is still faster than play, or still travelling backward.
  return "follow";
}
