import { describe, it, expect } from "vitest";
import { alignWords, estimateBias, globalLag, nearestOnset } from "./align";

// A "song". ★ The onsets are IRREGULAR on purpose, because real singing is not a metronome — and
// because a perfectly periodic fixture is genuinely AMBIGUOUS: with onsets every 500 ms, a 400 ms
// offset is mathematically indistinguishable from a −100 ms one, and no algorithm could tell them
// apart. (The first version of this fixture WAS a metronome, and it hid exactly that: the shipped
// nearest-onset estimator aliases, and a periodic fixture can't reveal it.)
//
// Some onsets carry no word (a breath, a bleed-through transient), so the aligner must be able to
// decline them. The words sung on the rest are the ground truth we try to recover.
const onsets: number[] = [];
{
  const spacings = [0.28, 0.45, 0.33, 0.61, 0.24, 0.52, 0.39, 0.75, 0.31, 0.44];
  let t = 1;
  for (let i = 0; t < 32; i++) {
    onsets.push(Number(t.toFixed(3)));
    t += spacings[i % spacings.length];
  }
}
const truth = onsets.filter((_, i) => i % 7 !== 3); // ~86% of onsets are word starts

/** Worst error of any word, in ms — the number a listener actually perceives. */
const worstMs = (got: number[], want: number[]) => Math.max(...got.map((t, i) => Math.abs(t - want[i]))) * 1000;
const medMs = (got: number[], want: number[]) => {
  const e = got.map((t, i) => Math.abs(t - want[i])).sort((a, b) => a - b);
  return e[e.length >> 1] * 1000;
};

describe("globalLag — the alias-resistant offset estimate", () => {
  it("★ THE BUG THIS REPLACES: nearest-onset averaging ALIASES, a lag scan does not", () => {
    // 400ms early. Under the old "distance to the nearest onset" method every word is closer to the
    // PREVIOUS onset than to its own, so the offset reads as a small NEGATIVE number and a badly
    // misaligned track gets a clean bill of health. The scan recovers the truth.
    const bad = truth.map((t) => t - 0.4);
    const naive = bad.map((t) => nearestOnset(onsets, t) - t);
    const naiveMedian = [...naive].sort((a, b) => a - b)[naive.length >> 1];
    expect(Math.abs(naiveMedian)).toBeLessThan(0.3); // the naive method UNDERSTATES it — the bug

    expect(globalLag(bad, onsets)).toBeCloseTo(0.4, 1); // the scan sees the real 400ms
  });

  it("finds a zero lag when the words are already right", () => {
    expect(Math.abs(globalLag(truth, onsets))).toBeLessThan(0.02);
  });
});

describe("estimateBias — find the systematic error, robustly", () => {
  it("recovers a constant offset", () => {
    const late = truth.map((t) => t - 0.4); // Whisper says the word came 400ms EARLIER than it did
    const { bias, drift } = estimateBias(late, onsets);
    expect(bias).toBeCloseTo(0.4, 1);
    expect(Math.abs(drift)).toBeLessThan(0.01);
  });

  it("recovers a linear drift", () => {
    const drifty = truth.map((t) => t - 0.02 * t); // 2% slow → grows through the track
    const { drift } = estimateBias(drifty, onsets);
    expect(drift).toBeCloseTo(0.02, 2);
  });

  it("★ a handful of wild words cannot invent a drift that isn't there", () => {
    const noisy = truth.map((t) => t - 0.3);
    noisy[5] += 1.7; // outliers
    noisy[20] -= 1.4;
    noisy[41] += 1.9;
    const { bias, drift } = estimateBias(noisy, onsets);
    expect(bias).toBeCloseTo(0.3, 1);
    expect(Math.abs(drift)).toBeLessThan(0.01); // NOT dragged into a phantom slope
  });

  it("refuses to guess from too little data", () => {
    expect(estimateBias([1, 2], onsets)).toEqual({ bias: 0, drift: 0 });
    expect(estimateBias(truth, [1, 2])).toEqual({ bias: 0, drift: 0 });
  });
});

describe("alignWords — one pass that subsumes all three failure modes", () => {
  it("★ OFFSET: every word 400ms early → recovered onto the real onsets", () => {
    const bad = truth.map((t) => t - 0.4);
    expect(worstMs(bad, truth)).toBeCloseTo(400, 0); // before: 400ms out, uniformly
    const { times, report } = alignWords(bad, onsets);
    expect(report.applied).toBe(true);
    expect(report.bias).toBeCloseTo(0.4, 2);
    expect(worstMs(times, truth)).toBeLessThan(20); // after: on the money
  });

  it("★ DRIFT: error grows through the track → recovered end to end", () => {
    const bad = truth.map((t) => t - 0.02 * t); // by 30s it's 600ms out
    expect(worstMs(bad, truth)).toBeGreaterThan(500);
    const { times, report } = alignWords(bad, onsets);
    expect(report.drift).toBeCloseTo(0.02, 2);
    expect(worstMs(times, truth)).toBeLessThan(20);
    // and the END of the track, where drift hurts most, is as good as the start
    expect(Math.abs(times[59] - truth[59]) * 1000).toBeLessThan(20);
  });

  it("★ SCATTER: the model guessing ±200ms per word → snapped back onto the vocals", () => {
    // Deterministic pseudo-noise (no Math.random — tests must be reproducible).
    const bad = truth.map((t, i) => t + 0.2 * Math.sin(i * 12.9898) );
    expect(medMs(bad, truth)).toBeGreaterThan(80);
    const { times, report } = alignWords(bad, onsets);
    expect(report.snapped).toBeGreaterThan(50); // most words found their onset
    expect(medMs(times, truth)).toBeLessThan(20);
  });

  it("★ DRIFT + SCATTER: the case that used to make alignment WORSE", () => {
    // A REGRESSION GUARD, and the reason the estimator is a 2-D scan rather than the (cleverer,
    // cheaper) chunk-and-fit-a-line approach. With drift and per-word noise together — the realistic
    // combination — the chunked estimator invented a confident −350 ms bias on a track whose real
    // fault was a +1.5% drift, applied it, and made the median error THREE TIMES WORSE than doing
    // nothing (241 ms → 610 ms). An aligner that can make things worse is worse than no aligner:
    // the user has no way to know which one they got.
    const bad = truth.map((t, i) => t - 0.015 * t + 0.12 * Math.sin(i * 7.13));
    const { times, report } = alignWords(bad, onsets);
    expect(report.drift).toBeCloseTo(0.015, 2); // the drift is FOUND, not mistaken for an offset
    expect(medMs(times, truth)).toBeLessThan(30);
    expect(medMs(times, truth)).toBeLessThan(medMs(bad, truth)); // and never, ever worse
  });

  it("★ all three at once — offset + drift + scatter", () => {
    const bad = truth.map((t, i) => t - 0.35 - 0.015 * t + 0.12 * Math.sin(i * 7.13));
    expect(medMs(bad, truth)).toBeGreaterThan(400);
    const { times } = alignWords(bad, onsets);
    // Judged on the MEDIAN, not the worst case. When a word's true onset is genuinely ambiguous —
    // its neighbour is as plausible as it is — no aligner can be certain, and a rare word will land
    // one transient off. Demanding a perfect worst case would be demanding the impossible and would
    // only tempt us into tuning against the fixture.
    expect(medMs(times, truth)).toBeLessThan(30);
    const errs = times.map((t, i) => Math.abs(t - truth[i]) * 1000).sort((a, b) => a - b);
    expect(errs[Math.floor(errs.length * 0.9)]).toBeLessThan(120); // 90% of words land clean
  });

  it("★ never makes alignment worse than doing nothing — across every fault mode", () => {
    const modes: [string, number[]][] = [
      ["offset", truth.map((t) => t - 0.35)],
      ["drift", truth.map((t) => t - 0.015 * t)],
      ["scatter", truth.map((t, i) => t + 0.15 * Math.sin(i * 7.13))],
      ["offset+scatter", truth.map((t, i) => t - 0.35 + 0.12 * Math.sin(i * 7.13))],
      ["drift+scatter", truth.map((t, i) => t - 0.015 * t + 0.12 * Math.sin(i * 7.13))],
      ["all three", truth.map((t, i) => t - 0.35 - 0.015 * t + 0.12 * Math.sin(i * 7.13))],
      ["already correct", [...truth]],
    ];
    for (const [name, bad] of modes) {
      const { times } = alignWords(bad, onsets);
      expect(medMs(times, truth), `${name} got worse`).toBeLessThanOrEqual(medMs(bad, truth) + 1);
    }
  });

  it("never reorders words, and never lets two land on the same tick", () => {
    const bad = truth.map((t, i) => t + 0.3 * Math.sin(i * 3.3));
    const { times } = alignWords(bad, onsets);
    for (let i = 1; i < times.length; i++) expect(times[i]).toBeGreaterThan(times[i - 1]);
  });

  it("★ LEGATO: a held phrase with NO onsets keeps the model's structure instead of being forced", () => {
    // Onsets exist early and late, but there is a genuine 6s legato hole in the middle. Words sung
    // through it must NOT be dragged onto a distant onset — that would be worse than leaving them.
    const holed = onsets.filter((t) => t < 10 || t > 16);
    const words = [10.5, 11.4, 12.6, 13.9, 15.1]; // inside the hole, already correct
    const { times, report } = alignWords(words, holed, { window: 0.35 });
    expect(report.free).toBe(5); // all declined the distant onsets
    for (let i = 0; i < words.length; i++) expect(Math.abs(times[i] - words[i])).toBeLessThan(0.06);
  });

  it("★ preserves the INTERNAL rhythm of a line rather than snapping each word independently", () => {
    // Four fast words (rap triplet) sung between two onsets. A naive nearest-onset snap collapses
    // them all onto the same tick. The gap-preserving DP must keep them spread.
    const sparse = [2.0, 4.0];
    const words = [2.05, 2.18, 2.31, 2.44];
    const { times } = alignWords(words, sparse, { window: 0.35 });
    const gaps = times.slice(1).map((t, i) => t - times[i]);
    for (const g of gaps) expect(g).toBeGreaterThan(0.1); // still four distinct words, not one
  });

  it("passes input through untouched when there is nothing to align against", () => {
    const { times, report } = alignWords(truth, [1, 2]);
    expect(report.applied).toBe(false);
    expect(times).toEqual(truth);
  });

  it("reports what it DID — bias, drift, snapped/free, how far words moved", () => {
    const { report } = alignWords(
      truth.map((t) => t - 0.4),
      onsets,
    );
    expect(report.bias).toBeCloseTo(0.4, 2);
    expect(report.snapped + report.free).toBe(truth.length);
    expect(report.medianMove).toBeCloseTo(0.4, 1);
  });
});

describe("nearestOnset", () => {
  it("finds the closest, and clamps at both ends", () => {
    expect(nearestOnset([1, 2, 3], 2.4)).toBe(2);
    expect(nearestOnset([1, 2, 3], 2.6)).toBe(3);
    expect(nearestOnset([1, 2, 3], 0)).toBe(1);
    expect(nearestOnset([1, 2, 3], 9)).toBe(3);
    expect(nearestOnset([], 5)).toBe(5);
  });
});
