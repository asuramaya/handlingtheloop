import { describe, expect, it } from "vitest";
import { type AudioLike, type Beatgrid, analyzeTrack, detectBeatgrid } from "./analyze";

// HOW WRONG IS A REUSED GRID WHEN THE AUDIO UNDERNEATH IT IS NOT THE AUDIO IT WAS DERIVED FROM?
//
// The cache-first load (App.tsx) reuses a beatgrid from the shared dataset on three conditions:
// same videoId, a stored `version` at least ours, and a readable format epoch. Nothing compares the
// grid to the buffer this device actually decoded, and `analyzeTrack` takes it VERBATIM —
// `const beatgrid = suppliedGrid ?? detectBeatgrid(buffer)`. `firstBeat` is an absolute time in
// seconds, so any difference in where the audio starts shifts every beat in the track by that much.
//
// This is a MEASUREMENT with its own controls, not an assertion that the defect is live. The
// premise it rests on — that the audio served for one videoId can differ between devices — is NOT
// established here and is not claimed. What is established is the consequence if it ever does, and
// the tolerance a guard would need.
//
// It can fail in three directions, which is the point of writing it this way:
//   • the metric is broken → the D=0 control would not read ~0;
//   • the audio is unanalysable → the re-derive control would not recover the beats;
//   • somebody adds re-anchoring downstream → the shifted rows drop to ~0 and these numbers change.

const SR = 48000;

/** A click track: an impulse every `interval` seconds with a short decaying tail, from `lead`
 *  seconds in. Two takes of the same track differing only in `lead` is exactly the shape under
 *  test — same music, a different amount of silence in front of it. */
function clicks(seconds: number, interval: number, lead: number): AudioLike {
  const length = Math.round(seconds * SR);
  const d = new Float32Array(length);
  for (let t = lead; t < seconds; t += interval) {
    const at = Math.round(t * SR);
    for (let k = 0; k < 900 && at + k < length; k++) d[at + k] = Math.exp(-k / 140) * Math.sin((k / SR) * 2 * Math.PI * 180);
  }
  return { sampleRate: SR, length, numberOfChannels: 1, getChannelData: () => d };
}

/** Where the grid says the beats are, over `seconds`. Prefers the tracked beats, falls back to the
 *  uniform comb — the same order every consumer of a Beatgrid uses. */
function predicted(g: Beatgrid, seconds: number): number[] {
  if (g.beats?.length) return Array.from(g.beats).filter((t) => t >= 0 && t <= seconds);
  const out: number[] = [];
  for (let t = g.firstBeat; t <= seconds; t += g.interval) out.push(t);
  return out;
}

/** Median distance from each predicted beat to the nearest real click, IN BEATS. Beats, not
 *  seconds, because that is the unit the error matters in: 0.5 is maximally wrong (the grid lands
 *  exactly between two beats) and any value near it is unmixable however small it looks in ms. */
function errorInBeats(g: Beatgrid, truth: number[], seconds: number): number {
  const pred = predicted(g, seconds);
  if (!pred.length || !truth.length) return NaN;
  const errs = pred
    .map((p) => Math.min(...truth.map((t) => Math.abs(t - p))) / g.interval)
    .map((e) => Math.min(e, 1 - e)) // a whole beat out is in phase; only the fraction matters
    .sort((a, b) => a - b);
  return errs[errs.length >> 1];
}

describe("a pooled grid reused over audio it was not derived from", () => {
  const SECONDS = 24;
  const INTERVAL = 0.5; // 120 bpm

  it("measures the misalignment, and the controls say the measurement works", () => {
    const own = clicks(SECONDS, INTERVAL, 0.1);
    const grid = detectBeatgrid(own);
    expect(grid).not.toBeNull();
    const truthOwn = [];
    for (let t = 0.1; t < SECONDS; t += INTERVAL) truthOwn.push(t);

    // CONTROL 1, AND IT IS ALSO THE FLOOR. The grid against its own audio does NOT read zero: it
    // reads about 0.05 beats (~25 ms at this tempo), because onset detection sees an impulse
    // through a smoothed envelope and lands slightly late. That is the detector's own bias, not a
    // defect, and every number below is read against it rather than against zero — a measurement
    // that quietly counted its instrument's offset as signal would overstate every row.
    const floor = errorInBeats(analyzeTrack(own, grid).beatgrid!, truthOwn, SECONDS);
    expect(floor).toBeLessThan(0.08); // still small enough that the rows below are readable

    // THE MEASUREMENT — the same music with 250 ms more silence in front of it, carrying the grid
    // from the first take. Half a beat at this tempo, which is the worst case: the reused grid
    // lands exactly between the beats of the audio it is describing.
    const shifted = clicks(SECONDS, INTERVAL, 0.35);
    const truthShifted = [];
    for (let t = 0.35; t < SECONDS; t += INTERVAL) truthShifted.push(t);
    const reused = errorInBeats(analyzeTrack(shifted, grid).beatgrid!, truthShifted, SECONDS);
    expect(reused - floor).toBeGreaterThan(0.4); // ~0.5 beats: as wrong as a beatgrid can be

    // CONTROL 2 — the audio is perfectly analysable; the error is the REUSE, not the material.
    // This is the behaviour the current gate skips, and the behaviour a rejected grid falls back
    // to, so it is also the cost of guarding: one local re-derive.
    const derived = errorInBeats(analyzeTrack(shifted).beatgrid!, truthShifted, SECONDS);
    expect(derived).toBeLessThan(floor + 0.02); // back to the floor — the material was never the problem
  });

  it("a small offset is a proportionally small error — there is no threshold below which it is free", () => {
    // The error is the offset, full stop: it does not wash out over the track and no amount of it
    // is absorbed. 30 ms is inaudible as latency and still 6% of a beat of permanent phase error
    // on every beat of the track, which is what a phase-lock loop would then be asked to hold.
    const own = clicks(SECONDS, INTERVAL, 0.1);
    const grid = detectBeatgrid(own)!;
    const ownTruth = [];
    for (let t = 0.1; t < SECONDS; t += INTERVAL) ownTruth.push(t);
    const shifted = clicks(SECONDS, INTERVAL, 0.13);
    const truth = [];
    for (let t = 0.13; t < SECONDS; t += INTERVAL) truth.push(t);
    const floor = errorInBeats(analyzeTrack(own, grid).beatgrid!, ownTruth, SECONDS);
    const e = errorInBeats(analyzeTrack(shifted, grid).beatgrid!, truth, SECONDS);
    // 30 ms of offset is 6% of a beat here, and that is what shows up over the floor: no rounding,
    // no absorption, no threshold below which it is free.
    expect(e - floor).toBeGreaterThan(0.04);
    expect(e - floor).toBeLessThan(0.08);
  });
});
