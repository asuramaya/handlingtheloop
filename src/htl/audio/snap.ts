// ★ THE LOCK — the house pattern for any drag that quantises (delay time, LFO rate, loop length,
// beat-repeat, anything that lands on a musical ladder).
//
// A quantised drag chops, and the instinct is to smooth it. That instinct is wrong: a quantised
// value has no in-between, so interpolating toward it just makes the chop mushy — it still lands
// on a rung, it just takes longer and feels vague. The chop is not caused by the jump.
//
// THE CHOP IS CAUSED BY THE BOUNDARY. Recompute "nearest rung" from scratch every frame and a
// finger resting anywhere near a midpoint will flip the answer back and forth on a single pixel of
// jitter — the value machine-guns between two rungs and the surface reads as fighting you. Sixty
// times a second, it changes its mind.
//
// So: LOCK, don't smooth. Once you're on a rung you STAY there, and only let go when the finger is
// clearly past the midpoint toward the next one. The transition stays instant and decisive — that
// snap is the point, it's what a grid magnet feels like — but it can never oscillate, because
// leaving a rung costs more than arriving did.
//
// And musical ladders are RATIOS, not offsets: 1/8 → 1/4 is a doubling, and 1 bar → 2 bars is the
// same musical distance as 1/16 → 1/8. Measure in LOG space or the long divisions become
// impossible to land on and the short ones impossible to leave.

/**
 * Which rung of `targets` a value locks to, given the rung it's currently on.
 *
 * @param value    the continuous intent (where the finger is)
 * @param targets  the ladder, ascending — any positive units (beats, Hz, seconds)
 * @param current  the rung we're on now; pass -1 (or out of range) for "no opinion, take nearest"
 * @param stick    how much of the gap you must travel PAST the midpoint before the lock lets go.
 *                 0 = no hysteresis (the flicker we're fixing). 0.3 = you must be ~65% of the way
 *                 to the next rung, giving a 30%-of-the-gap deadband on either side of it.
 */
export function snapIndex(value: number, targets: readonly number[], current: number, stick = 0.3): number {
  if (targets.length === 0) return -1;
  const v = Math.max(1e-9, value);
  const dist = (i: number) => Math.abs(Math.log(targets[i] / v));

  let best = 0;
  for (let i = 1; i < targets.length; i++) if (dist(i) < dist(best)) best = i;

  const held = current >= 0 && current < targets.length ? current : best;
  if (best === held) return held;

  // The gap between the rung we're holding and the one we'd move to — in log space, so it's the
  // musical distance, not the numeric one.
  const gap = Math.abs(Math.log(targets[best] / targets[held]));
  if (gap === 0) return held;

  // At the exact midpoint dist(held) === dist(best), so the difference is 0 and we HOLD. The lock
  // only releases once the finger is `stick` of the gap beyond that midpoint.
  return dist(held) - dist(best) > gap * stick ? best : held;
}
