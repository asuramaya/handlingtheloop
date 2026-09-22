import { describe, expect, it } from "vitest";
import { type AudioLike, detectBeatgrid } from "./analyze";

// WHERE DOES THE DETECTOR THINK A BEAT IS, AND HOW WELL DOES IT KNOW?
//
// Metron's sync rig reaches a floor it cannot get past on a MISMATCHED pair — two decks carrying
// different grids, which is every real mix. Settled error 0.028 beats, worst 0.103, and he has
// killed two explanations for it with measurements: doubling SYNC_TRIM_MAX removed saturation
// entirely and left the error at 0.029, and tripling the phase gain kp left it at 0.029 too. So it
// is neither budget- nor bandwidth-limited. On MATCHED grids the same scenarios settle at 0.004.
//
// ★ THE CANDIDATE THIS FILE TESTS: there may be nothing left for the loop to correct. A beatgrid
// does not know where the beats are exactly — the onset envelope is bucketed, so every beat time
// carries a quantisation error. When both decks run the SAME grid that error is common-mode and
// cancels; on two different grids the errors are independent and their difference is a phase
// disagreement no control loop can remove, because neither grid is more right than the other.
//
// This measures that quantisation directly, against ground truth, on material where the true beat
// times are known to the sample. If the per-beat error is of the order Metron's mismatched floor,
// the floor is the grid's resolution rather than a defect in his loop.

const SR = 48000;
const SECONDS = 60;

function clickTrack(bpm: number, phase: number): { buf: AudioLike; truth: number[] } {
  const ivl = 60 / bpm;
  const length = Math.round(SECONDS * SR);
  const d = new Float32Array(length);
  const truth: number[] = [];
  const click = (() => {
    let s = 99;
    return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
  })();
  for (let t = 1 + phase; t < SECONDS - 1; t += ivl) {
    truth.push(t);
    const at = Math.round(t * SR);
    for (let i = 0; i < SR * 0.25 && at + i < length; i++) {
      const s = i / SR;
      d[at + i] += Math.exp(-s * 18) * Math.sin(2 * Math.PI * (52 + 60 * Math.exp(-s * 40)) * s);
    }
    for (let i = 0; i < SR * 0.006 && at + i < length; i++) d[at + i] += 0.3 * Math.exp(-(i / SR) * 400) * click();
  }
  let peak = 0;
  for (const x of d) peak = Math.max(peak, Math.abs(x));
  if (peak > 0) for (let i = 0; i < length; i++) d[i] /= peak;
  return { buf: { sampleRate: SR, length, numberOfChannels: 1, getChannelData: () => d }, truth };
}

/** Per-beat position error against ground truth, in BEATS, with the constant part removed. A fixed
 *  lag is NOT an error the sync loop sees — it shifts both decks' grids the same way and the phase
 *  lock simply locks to it. What a mismatched pair suffers is the part that VARIES beat to beat. */
function positionError(bpm: number, phase: number): { bias: number; rms: number; worst: number } {
  const { buf, truth } = clickTrack(bpm, phase);
  const g = detectBeatgrid(buf);
  expect(g?.beats, `${bpm}: no tracked beats`).toBeTruthy();
  const b = g!.beats!;
  const ivl = 60 / bpm;
  const errs: number[] = [];
  for (const t of truth) {
    let near = b[0];
    for (let i = 1; i < b.length; i++) if (Math.abs(b[i] - t) < Math.abs(near - t)) near = b[i];
    if (Math.abs(near - t) < ivl / 2) errs.push((near - t) / ivl);
  }
  const bias = errs.reduce((a, c) => a + c, 0) / errs.length;
  const dev = errs.map((e) => e - bias);
  return {
    bias,
    rms: Math.sqrt(dev.reduce((a, c) => a + c * c, 0) / dev.length),
    worst: Math.max(...dev.map(Math.abs)),
  };
}

describe("how precisely a beatgrid knows where its beats are", () => {
  it("carries a per-beat jitter of the same order as the sync loop's mismatched-pair floor", () => {
    const rows = ["", "  per-beat position error vs GROUND TRUTH, in beats (constant lag removed)", "", "  bpm     bias     jitter RMS   worst    two independent grids: RMS"];
    const out: { bpm: number; rms: number; worst: number }[] = [];
    for (const bpm of [96, 120, 128, 140, 160]) {
      // Two takes at the same tempo with DIFFERENT start phases stand in for two different records:
      // same clock, independent quantisation. That difference is what a mismatched pair is asked to
      // null, and it is the quantity Metron's floor should be compared against.
      const a = positionError(bpm, 0);
      const b = positionError(bpm, (60 / bpm) * 0.31);
      const pair = Math.sqrt(a.rms ** 2 + b.rms ** 2);
      out.push({ bpm, rms: a.rms, worst: a.worst });
      const f = (x: number) => x.toFixed(4).padStart(9);
      rows.push(`  ${String(bpm).padEnd(8)}${f(a.bias)}${f(a.rms)}${f(a.worst)}${f(pair)}`);
    }
    rows.push("");
    rows.push("  Metron's sync rig, for comparison (08d40a94):");
    rows.push("    matched grids      settled 0.004 beats     — the same grid on both decks, error cancels");
    rows.push("    MISMATCHED pair    settled 0.028, worst 0.103   — unmoved by 2x budget or 3x gain");
    rows.push("");
    console.log(rows.join("\n"));

    // The grid does not know beat positions exactly, and the error is not a constant lag it could
    // be calibrated out of — it varies beat to beat.
    for (const r of out) {
      expect(r.rms, `${r.bpm}: suspiciously exact`).toBeGreaterThan(0.001);
      expect(r.rms, `${r.bpm}: too coarse to be quantisation`).toBeLessThan(0.05);
    }
    // And it is the right ORDER for Metron's floor: a mismatched pair combines two of these.
    const worstPair = Math.max(...out.map((r) => r.rms)) * Math.SQRT2;
    expect(worstPair).toBeGreaterThan(0.005);
    expect(worstPair).toBeLessThan(0.1);
  }, 240_000);
});
