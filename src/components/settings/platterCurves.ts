// What Settings ▸ Turntable draws: how the platter (and the ring's tempo push) moves over time for
// each gesture, computed by the deck's own physics (servoStep / brakeFriction / stepBend) with the
// deck's own knob mappings (platterTaus, platterDrag, RING_BEND). Nothing here is a hand-drawn
// approximation: if a curve on screen and the deck disagree, one of those exports changed and
// this follows it.
import { brakeFriction, platterDrag, platterTaus, servoStep } from "@htl/audio/JogEngine";
import { RING_BEND, stepBend } from "@htl/audio/bendPhysics";
import { simulateSyncRecovery, SYNC_TRIM_MAX } from "@htl/audio/syncLoop";

export interface PlatterKnobs {
  mass: number; // jogWeight
  start: number; // vinylStartTime (0 = instant)
  brake: number; // vinylBrakeTime (0 = instant)
  backSpin: number; // backSpinLength
}

export type CurveKey = "play" | "pause" | "letGo" | "backSpin" | "ring" | "sync";
export interface Curve {
  key: CurveKey;
  title: string;
  /** One or two traces, sampled every DT seconds. */
  lines: { label: string; v: number[] }[];
  yMin: number;
  yMax: number;
  /** The value the gesture settles to (for the duration readout and the reference line). */
  rest: number;
  unit: "×" | "%";
}

export const DT = 1 / 120;
export const SPAN_S = 1.2; // seconds shown per panel

const n = Math.round(SPAN_S / DT);

/** A motor (or release) spinning the platter up to `target`: the deck's catch-up servo. */
function servo(v0: number, target: number, tau: number): number[] {
  if (tau <= 0) return [v0, ...new Array(n - 1).fill(target)];
  const out: number[] = [];
  let s = { v: v0, a: 0 };
  for (let i = 0; i < n; i++) {
    out.push(s.v);
    s = servoStep(s, target, DT, tau);
  }
  return out;
}

/** A hand or the motor's brake gripping the platter to a stop: the deck's friction model. */
function brake(v0: number, tau: number): number[] {
  if (tau <= 0) return [v0, ...new Array(n - 1).fill(0)];
  const out: number[] = [];
  let s = { v: v0, z: 0 };
  for (let i = 0; i < n; i++) {
    out.push(s.v);
    s = brakeFriction(s, DT, tau);
  }
  return out;
}

/** Release speed used to illustrate "let go while paused": a firm push. */
export const FLING = 1.5;

export function platterCurves(k: PlatterKnobs): Curve[] {
  const strength = platterTaus.backSpinStrength(k.backSpin);
  return [
    {
      key: "play",
      title: "Play",
      lines: [{ label: "spin-up", v: servo(0, 1, k.start > 0 ? platterTaus.start(k.start) : 0) }],
      yMin: 0,
      yMax: 1.15,
      rest: 1,
      unit: "×",
    },
    {
      key: "pause",
      title: "Pause",
      lines: [{ label: "spin-down", v: brake(1, k.brake > 0 ? platterTaus.brake(k.brake) : 0) }],
      yMin: 0,
      yMax: 1.15,
      rest: 0,
      unit: "×",
    },
    {
      key: "letGo",
      title: "Let go",
      lines: [
        // Grabbed and held still on a playing deck, then released: the servo catches it up.
        { label: "playing", v: servo(0, 1, platterTaus.catchUp(k.mass)) },
        // Pushed and released on a paused deck: friction glides it to a stop.
        { label: "paused", v: brake(FLING, platterTaus.glide(k.mass, platterDrag(k.mass))) },
      ],
      yMin: 0,
      yMax: FLING * 1.08,
      rest: 1,
      unit: "×",
    },
    {
      key: "backSpin",
      title: "Back spin",
      lines: [{ label: "throw + catch", v: servo(-strength, 1, platterTaus.backSpin(k.backSpin)) }],
      yMin: -14.5,
      yMax: 2,
      rest: 1,
      unit: "×",
    },
  ];
}

/** Ring bend: the outer ring turned gently (RING_TURN rate-seconds per second) for RING_HOLD_S,
 *  then let go. The deck's own stepBend + RING_BEND, so the push and its ease-out are the deck's.
 *  Traced as tempo offset in % (0 = the set tempo). */
export const RING_TURN = 0.1;
export const RING_HOLD_S = 0.4;
export function ringCurve(strength: number): Curve {
  const p = { gain: RING_BEND.gain * strength, decay: RING_BEND.decay, max: RING_BEND.max };
  const v: number[] = [];
  let s = { bend: 0, ringVel: 0 };
  for (let i = 0; i < n; i++) {
    v.push(s.bend * 100);
    s = stepBend(s, i * DT < RING_HOLD_S ? RING_TURN * DT : 0, DT, p);
  }
  // Scaled to the STRONGEST setting's push (strength 2), not to the clamp: against the clamp a
  // normal push drew as a flat bump, and the curve barely moved with its own slider.
  return { key: "ring", title: "Ring bend", lines: [{ label: "push", v }], yMin: 0, yMax: RING_SCALE, rest: 0, unit: "%" };
}

/** Seconds until a trace first comes within `tol` of `target` (and stays): the number printed
 *  under each panel, so the graph also reads as a value. */
export function settleTime(v: number[], target: number, tol = 0.03): number {
  for (let i = v.length - 1; i >= 0; i--) if (Math.abs(v[i] - target) > tol) return Math.min(SPAN_S, (i + 1) * DT);
  return 0;
}

export const peak = (v: number[]) => v.reduce((m, x) => (Math.abs(x) > Math.abs(m) ? x : m), 0);

/** The ring tile's fixed vertical scale: the peak push at the strongest Ring bend (×2), + 10%. */
const RING_SCALE = (() => {
  const p = { gain: RING_BEND.gain * 2, decay: RING_BEND.decay, max: RING_BEND.max };
  let s = { bend: 0, ringVel: 0 };
  let m = 0;
  for (let i = 0; i < n; i++) {
    s = stepBend(s, i * DT < RING_HOLD_S ? RING_TURN * DT : 0, DT, p);
    m = Math.max(m, s.bend * 100);
  }
  return m * 1.1;
})();

/** Seconds shown on the Sync pull tile, and the jump it recovers from (beats). */
export const SYNC_SPAN_S = 12;
export const SYNC_JUMP_BEATS = 0.25;

/** Settings ▸ Turntable ▸ Sync pull: the SYNC phase-lock pulling a pair back from a quarter-beat jump
 *  (a drift, a nudge), by the engine's own loop (syncLoop.ts). Solid: the phase error in beats.
 *  Dashed: the speed bend it costs, drawn so the clamp is the height of the jump; the readout gives
 *  it in %. */
export function syncCurve(kp: number): Curve & { settleS: number; peakTrim: number } {
  const r = simulateSyncRecovery(kp, SYNC_JUMP_BEATS, 128, SYNC_SPAN_S);
  const step = Math.max(1, Math.floor(r.err.length / 120));
  const pick = (a: number[]) => a.filter((_, i) => i % step === 0);
  return {
    key: "sync",
    title: "Sync pull",
    lines: [
      { label: "phase", v: pick(r.err) },
      { label: "bend", v: pick(r.trim.map((t) => (Math.abs(t) / SYNC_TRIM_MAX) * SYNC_JUMP_BEATS)) },
    ],
    yMin: -0.02,
    yMax: SYNC_JUMP_BEATS + 0.02,
    rest: 0,
    unit: "%",
    settleS: r.settleS,
    peakTrim: r.peakTrim,
  };
}
