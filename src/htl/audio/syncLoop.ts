// The SYNC phase-lock loop's constants, in one place, and a simulation of the loop itself.
//
// AudioEngine runs this loop on a live pair every SYNC_TICK_MS (phaseCorrect: piTrim on the beat
// phase error, the trim clamped to Deck.SYNC_TRIM_MAX). Settings ▸ Turntable ▸ Sync pull draws what
// the setting does with the SAME step function and the SAME constants (operator, 2026-11-03: explain
// item 7 → "explain this after you work on the first few"; then "lets keep working on the
// remainder"). A graph that re-derived the controller would be a second copy free to drift.
import { piTrim } from "../analysis/analyze";

/** Phase-lock poll period. */
export const SYNC_TICK_MS = 80;
/** Default P-gain: rate trim per beat of phase error (gentle, ~8 s time constant). */
export const SYNC_PHASE_K = 0.06;
/** I-gain: nulls the residual steady-state offset a P-only loop leaves; slow and well damped. */
export const SYNC_INTEGRAL_K = 0.003;
/** The trim clamp (fraction of tempo). Mirrors Deck.SYNC_TRIM_MAX. */
export const SYNC_TRIM_MAX = 0.06;

export interface SyncRecovery {
  /** Phase error in beats, one sample per tick. */
  err: number[];
  /** The rate trim the loop applied, fraction of tempo, one per tick. */
  trim: number[];
  /** Seconds until the error is within `settleBeats` and stays there (Infinity if never). */
  settleS: number;
  /** Largest |trim| used (fraction of tempo): the pitch cost when key-lock is off. */
  peakTrim: number;
}

/** Simulate the loop pulling a pair back from `err0` beats out, at `bpm`, for `seconds`. The plant
 *  is exact for a steady pair: a trim of `t` moves the follower's phase by t × beats-per-second. */
export function simulateSyncRecovery(kp: number, err0 = 0.25, bpm = 128, seconds = 12, settleBeats = 0.02): SyncRecovery {
  const dt = SYNC_TICK_MS / 1000;
  const bps = bpm / 60;
  const steps = Math.round(seconds / dt);
  const err: number[] = [];
  const trim: number[] = [];
  let e = err0;
  let integral = 0;
  for (let i = 0; i < steps; i++) {
    const pi = piTrim({ err: e, integral, dt, kp, ki: SYNC_INTEGRAL_K, clamp: SYNC_TRIM_MAX });
    integral = pi.integral;
    err.push(e);
    trim.push(pi.trim);
    e += pi.trim * bps * dt;
  }
  let last = -1;
  for (let i = 0; i < err.length; i++) if (Math.abs(err[i]) > settleBeats) last = i;
  const settleS = last === err.length - 1 ? Infinity : (last + 1) * dt;
  return { err, trim, settleS, peakTrim: Math.max(...trim.map(Math.abs)) };
}
