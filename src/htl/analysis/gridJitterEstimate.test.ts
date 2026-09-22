import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { type AudioLike, detectBeatgrid } from "./analyze";

// HOW JITTERY IS A REAL GRID — WITHOUT GROUND TRUTH TO COMPARE IT TO?
//
// acea13b8 measured beat-position jitter against ground truth on synthetic clicks: 0.0137 beats RMS
// at 128, so 0.019 for a pair of independent grids. Metron then confirmed the model on his loop —
// injected jitter 0.0138 / 0.0232 / 0.0500 gives settled error 0.012 / 0.019 / 0.041, a straight
// line at 0.82–0.87x across a 3.6x range (4efe5dd). One gap is left, and it is his open row: a REAL
// mixed pair behaves like ~0.035 beats of effective jitter, against 0.019 for quantisation alone.
//
// A real track has no ground truth, so the direct measurement is impossible. But the two components
// separate by their SHAPE. Rubato is smooth — a performance speeds and slows over bars. Quantisation
// is white — each beat is rounded independently of its neighbours. The SECOND DIFFERENCE of the beat
// times is a high-pass: it nearly annihilates a smooth curve and multiplies white noise by a known
// factor, var(Δ²) = 6σ² for independent errors of variance σ².
//
// ★ THE ESTIMATOR IS CHECKED BEFORE IT IS USED, AND THE CHECK IS WHAT THIS FILE ENDED UP BEING FOR.
// It runs first on synthetic material where σ IS known from ground truth. It does not recover it
// cleanly: truth/raw comes out 0.93, 0.76, 2.91, 0.78 at 96/120/128/160 bpm. Three tempos agree
// within a quarter; 128 is four times out, because there the detector's position errors are
// strongly CORRELATED beat to beat rather than independent, and a second difference nearly cancels
// them. So there is no single calibration constant and no single "floor" to compare a real grid to.
//
// ★ WHICH KILLED THE HYPOTHESIS THIS FILE WAS WRITTEN TO CONFIRM. I expected real grids to carry
// several times the synthetic jitter, closing Metron's gap between 0.019 (quantisation) and the
// ~0.035 his real mixed pair behaves like. They do not: real grids come out 0.0042-0.0189, inside
// the synthetic range of 0.0047-0.0211. Real material is not measurably jitterier than the easiest
// signal the detector will ever see, so the gap is NOT that, and it stays open.
//
// What is left is a real finding of a different shape: the CHARACTER of the error is tempo
// dependent — white at some tempos, slow and correlated at others. That distinction matters to a
// phase loop, which can track a slow wander and cannot track white noise.

const SR = 48000;
const SECONDS = 60;

function clickTrack(bpm: number): AudioLike {
  const ivl = 60 / bpm;
  const length = Math.round(SECONDS * SR);
  const d = new Float32Array(length);
  let s = 99;
  const click = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
  for (let t = 1; t < SECONDS - 1; t += ivl) {
    const at = Math.round(t * SR);
    for (let i = 0; i < SR * 0.25 && at + i < length; i++) {
      const u = i / SR;
      d[at + i] += Math.exp(-u * 18) * Math.sin(2 * Math.PI * (52 + 60 * Math.exp(-u * 40)) * u);
    }
    for (let i = 0; i < SR * 0.006 && at + i < length; i++) d[at + i] += 0.3 * Math.exp(-(i / SR) * 400) * click();
  }
  let peak = 0;
  for (const x of d) peak = Math.max(peak, Math.abs(x));
  if (peak > 0) for (let i = 0; i < length; i++) d[i] /= peak;
  return { sampleRate: SR, length, numberOfChannels: 1, getChannelData: () => d };
}

/** Independent per-beat position noise, in BEATS, from the second difference of the beat times.
 *  Smooth tempo movement barely survives a second difference; independent rounding does, by a
 *  known factor. */
function whiteJitter(beats: ArrayLike<number>, interval: number): number {
  const d2: number[] = [];
  for (let i = 2; i < beats.length; i++) d2.push((beats[i] - 2 * beats[i - 1] + beats[i - 2]) / interval);
  const m = d2.reduce((a, c) => a + c, 0) / d2.length;
  const v = d2.reduce((a, c) => a + (c - m) ** 2, 0) / d2.length;
  return Math.sqrt(v / 6);
}

describe("beat-position jitter in real grids", () => {
  const TRUTH: Record<number, number> = { 96: 0.0098, 120: 0.0122, 128: 0.0137, 160: 0.0164 }; // acea13b8
  const synthetic: Record<number, number> = {};

  it("has no single calibration constant — the error is white at some tempos and correlated at others", () => {
    const rows = ["", "  ESTIMATOR CHECK — second-difference σ vs ground truth (acea13b8)", "", "  bpm      raw σ     ground truth    truth/raw"];
    for (const bpm of [96, 120, 128, 160]) {
      const g = detectBeatgrid(clickTrack(bpm));
      expect(g?.beats).toBeTruthy();
      const raw = whiteJitter(g!.beats!, g!.interval);
      synthetic[bpm] = raw;
      rows.push(`  ${String(bpm).padEnd(8)}${raw.toFixed(4).padStart(9)}${TRUTH[bpm].toFixed(4).padStart(15)}${(TRUTH[bpm] / raw).toFixed(2).padStart(13)}`);
    }
    rows.push("");
    console.log(rows.join("\n"));

    const ratios = Object.keys(synthetic).map(Number).map((b) => TRUTH[b] / synthetic[b]);
    // Three of the four agree closely; one is several times out. If that ever stops being true the
    // estimator has become usable as an absolute and this file should be rewritten around it.
    expect(Math.max(...ratios) / Math.min(...ratios), "the estimator became consistent — revisit").toBeGreaterThan(2);
    // The same total error, differently shaped: 128 has the LARGEST ground-truth jitter of the four
    // and the SMALLEST second difference, which is what "correlated rather than white" means.
    expect(synthetic[128]).toBeLessThan(synthetic[120]);
    expect(TRUTH[128]).toBeGreaterThan(TRUTH[120]);
  }, 240_000);

  it("finds real grids INSIDE the synthetic range, so they are not where the missing jitter is", () => {
    expect(Object.keys(synthetic).length, "calibration did not run").toBeGreaterThan(0);
    const fixture = JSON.parse(readFileSync(resolve(process.cwd(), "scripts/synclab/real-grids.json"), "utf8")) as {
      grids: { videoId: string; bpm: number; interval: number; beats: number[]; rmsIntervalSpread: number }[];
    };
    const rows = ["", "  REAL GRIDS — the white, untrackable component of their beat-position error", "", "  track            bpm    interval spread    white σ"];
    const real: number[] = [];
    for (const r of fixture.grids) {
      const raw = whiteJitter(r.beats, r.interval);
      real.push(raw);
      rows.push(`  ${r.videoId.padEnd(15)}${r.bpm.toFixed(2).padStart(7)}${`${(r.rmsIntervalSpread * 100).toFixed(2)}%`.padStart(19)}${raw.toFixed(4).padStart(11)}`);
    }
    const sv = Object.keys(synthetic).map(Number).map((b) => synthetic[b]);
    rows.push("");
    rows.push(`  synthetic clicks, same estimator, 96-160 bpm:  ${Math.min(...sv).toFixed(4)} - ${Math.max(...sv).toFixed(4)}`);
    rows.push(`  real grids:                                    ${Math.min(...real).toFixed(4)} - ${Math.max(...real).toFixed(4)}`);
    rows.push("  Metron's real mixed pair behaves like ~0.035 (4efe5dd) — still unexplained");
    rows.push("");
    console.log(rows.join("\n"));

    // THE RESULT, and it is a refusal: real grids sit inside the synthetic band. Real material is
    // not measurably jitterier than the easiest signal the detector will ever see, so "real grids
    // are noisier" does not close Metron's gap.
    expect(Math.max(...real)).toBeLessThan(Math.max(...sv) * 1.2);
    expect(Math.min(...real)).toBeGreaterThan(Math.min(...sv) * 0.8);
  });
});
