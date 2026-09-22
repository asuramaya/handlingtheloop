// How much the master is pulled down BEFORE the brickwall limiter — the one control that changes
// how hard the summed mix is driven into the ceiling.
//
// ★ WHY THIS EXISTS, measured (fxlab --master-duck, live path, decision 489901b3): with two decks
// summing above the limiter's -0.3 dB ceiling, a kick on one deck pulls the OTHER deck down 1.88 dB
// and takes 130 ms to come back — the "compressor punches from the other deck" report, and no
// per-deck control can reach it, because the limiter sees both decks already summed. 3 dB of
// headroom took it to 0.02 dB and 6 dB to 0.00; halving the limiter's release only shortened the
// recovery (1.68 dB / 85 ms). So the pumping is a gain-staging problem, not a limiter defect.
//
// It is a SETTING, defaulting to 0, because the fix costs output level: every dB of headroom is a
// dB quieter. Whether the app should be quieter by default is the operator's call, not this
// module's, and a default of 0 changes nobody's sound until they ask for it.

export const MAX_HEADROOM_DB = 12;

/** dB of trim (0..-12, clamped) -> a linear gain for the pre-limiter node. Anything unusable — a
 *  NaN from a corrupt settings blob, a positive value from a hand-edited one, an out-of-range
 *  number from a future build — resolves to unity, which is both safe and the previous behaviour. */
export function headroomGain(db: number): number {
  if (!Number.isFinite(db) || db >= 0) return 1;
  const d = db < -MAX_HEADROOM_DB ? -MAX_HEADROOM_DB : db;
  return Math.pow(10, d / 20);
}
