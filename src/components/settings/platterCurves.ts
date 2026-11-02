// What Settings ▸ Platter draws: the platter's SPEED over time for each gesture, computed by the
// deck's own physics (servoStep / brakeFriction) with the deck's own knob mappings (platterTaus,
// platterDrag). Nothing here is a hand-drawn approximation: if the curve on screen and the deck
// disagree, one of those exported functions changed and this follows it.
import { brakeFriction, platterDrag, platterTaus, servoStep } from "@htl/audio/JogEngine";

export interface PlatterKnobs {
  mass: number; // jogWeight
  start: number; // vinylStartTime (0 = instant)
  brake: number; // vinylBrakeTime (0 = instant)
  backSpin: number; // backSpinLength
}

export type CurveKey = "play" | "pause" | "letGo" | "backSpin";
export interface Curve {
  key: CurveKey;
  title: string;
  /** One or two speed traces (× realtime), sampled every DT seconds. */
  lines: { label: string; v: number[] }[];
  yMin: number;
  yMax: number;
}

export const DT = 1 / 120;
export const SPAN_S = 1.2; // seconds shown per panel

const n = Math.round(SPAN_S / DT);

/** A motor (or release) spinning the platter up to `target`: the deck's catch-up servo. */
function servo(v0: number, target: number, tau: number): number[] {
  if (tau <= 0) return new Array(n).fill(target);
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
      lines: [{ label: "spin-up", v: k.start > 0 ? servo(0, 1, platterTaus.start(k.start)) : servo(0, 1, 0) }],
      yMin: 0,
      yMax: 1.15,
    },
    {
      key: "pause",
      title: "Pause",
      lines: [{ label: "spin-down", v: k.brake > 0 ? brake(1, platterTaus.brake(k.brake)) : brake(1, 0) }],
      yMin: 0,
      yMax: 1.15,
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
    },
    {
      key: "backSpin",
      title: "Back spin",
      lines: [{ label: "throw + catch", v: servo(-strength, 1, platterTaus.backSpin(k.backSpin)) }],
      yMin: -14.5,
      yMax: 2,
    },
  ];
}

/** Seconds until a trace first comes within `tol` of `target` (and stays): the number printed
 *  under each panel, so the graph also reads as a value. */
export function settleTime(v: number[], target: number, tol = 0.03): number {
  for (let i = v.length - 1; i >= 0; i--) if (Math.abs(v[i] - target) > tol) return Math.min(SPAN_S, (i + 1) * DT);
  return 0;
}
