// followClock — the PURE rate math of a session follower's deck clock (Deck.followTick / endFollow).
//
// ★ Operator, 2026-11-11: session sync audit. A deck's clock is `startOffset + elapsed · rate`. If the
// rate changes WITHOUT re-anchoring first, the whole elapsed time since the last anchor is rescaled
// by the new rate: the playhead jumps by elapsed × Δrate (seconds of track after a minute of play),
// and the follower then "corrects" that phantom error with a seek. followTick used to swap the
// anchor's rate in with no re-anchor, and compared each tick's rate to the PREVIOUS tick's instead
// of to the rate actually pushed to the audio, so a slow ramp (< FOLLOW_RATE_EPS per tick) moved the
// clock without ever reaching the worklet. These two functions are that math, testable.

/** A tick's rate is adopted only when it differs from the rate last PUSHED by more than this. */
export const FOLLOW_RATE_EPS = 0.0008;

/** The rate the follower should adopt for this tick, or null to keep the one already pushed. The
 *  comparison is against `pushed` (what the audio AND the clock run at), never the previous tick, so
 *  a slow ramp accumulates until it crosses the threshold and the two never disagree. */
export function nextFollowRate(pushed: number | null, tickRate: number | null | undefined): number | null {
  if (tickRate == null || !(tickRate > 0)) return null;
  if (pushed == null || Math.abs(pushed - tickRate) > FOLLOW_RATE_EPS) return tickRate;
  return null;
}

export interface RateClock {
  startOffset: number; // track s at `startedAt`
  startedAt: number; //   clock s
  rate: number; //        track s per clock s
}

/** Where the clock reads at `now`. */
export function clockPos(c: RateClock, now: number): number {
  return c.startOffset + (now - c.startedAt) * c.rate;
}

/** Change the rate continuously: re-anchor at the current reading first, then swap the rate. */
export function setClockRate(c: RateClock, rate: number, now: number): RateClock {
  return { startOffset: clockPos(c, now), startedAt: now, rate };
}
