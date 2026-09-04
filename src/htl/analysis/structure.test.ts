import { describe, expect, it } from "vitest";
import { buildSSM, checkerboardNovelty, l2normalize, labelSegments, multiScaleNovelty, pickBoundaries } from "./structure";

function vec(...xs: number[]): Float32Array {
  return l2normalize(Float32Array.from(xs));
}

describe("l2normalize", () => {
  it("scales a vector to unit length", () => {
    const v = l2normalize(Float32Array.from([3, 4]));
    expect(Math.hypot(v[0], v[1])).toBeCloseTo(1, 6);
    expect(v[0]).toBeCloseTo(0.6, 6);
    expect(v[1]).toBeCloseTo(0.8, 6);
  });
  it("leaves a near-zero (silent) vector at zero instead of blowing up", () => {
    const v = l2normalize(Float32Array.from([0, 0, 1e-12]));
    expect(v[0]).toBe(0);
    expect(v[1]).toBe(0);
    expect(Number.isFinite(v[2])).toBe(true);
  });
});

describe("buildSSM", () => {
  it("is symmetric with a unit diagonal", () => {
    const vectors = [vec(1, 0), vec(0, 1), vec(1, 1)];
    const ssm = buildSSM(vectors);
    const n = 3;
    for (let i = 0; i < n; i++) expect(ssm[i * n + i]).toBeCloseTo(1, 5);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) expect(ssm[i * n + j]).toBeCloseTo(ssm[j * n + i], 6);
  });
  it("scores identical vectors 1 and orthogonal vectors 0", () => {
    const ssm = buildSSM([vec(1, 0), vec(1, 0), vec(0, 1)]);
    const n = 3;
    expect(ssm[0 * n + 1]).toBeCloseTo(1, 5);
    expect(ssm[0 * n + 2]).toBeCloseTo(0, 5);
  });
});

// A synthetic two-block track: bars 0..19 are one "section" (near-identical feature vectors,
// small jitter), bars 20..39 are a different section — the self-similarity matrix should look
// like two bright squares on the diagonal with a dim off-diagonal, and novelty should spike at
// the seam (bar ~20).
function twoBlockVectors(): Float32Array[] {
  const vectors: Float32Array[] = [];
  for (let b = 0; b < 40; b++) {
    const base = b < 20 ? [1, 0.1, 0] : [0, 0.1, 1];
    const jitter = ((b * 7919) % 100) / 100000; // deterministic tiny per-bar variation
    vectors.push(vec(base[0] + jitter, base[1], base[2] - jitter));
  }
  return vectors;
}

describe("checkerboardNovelty / multiScaleNovelty", () => {
  it("peaks at the real section boundary of a synthetic two-block SSM", () => {
    const vectors = twoBlockVectors();
    const ssm = buildSSM(vectors);
    const novelty = checkerboardNovelty(ssm, 40, 8);
    let peakBar = 0;
    for (let b = 1; b < 40; b++) if (novelty[b] > novelty[peakBar]) peakBar = b;
    expect(peakBar).toBeGreaterThanOrEqual(16);
    expect(peakBar).toBeLessThanOrEqual(24);
  });
  it("multiScaleNovelty also finds the boundary and stays bounded (no NaN/Infinity)", () => {
    const ssm = buildSSM(twoBlockVectors());
    const novelty = multiScaleNovelty(ssm, 40, [4, 8, 16]);
    for (let b = 0; b < 40; b++) expect(Number.isFinite(novelty[b])).toBe(true);
    let peakBar = 0;
    for (let b = 1; b < 40; b++) if (novelty[b] > novelty[peakBar]) peakBar = b;
    expect(peakBar).toBeGreaterThanOrEqual(14);
    expect(peakBar).toBeLessThanOrEqual(26);
  });
  it("returns all-zero (not a crash) when n is too small for the radius", () => {
    const ssm = buildSSM([vec(1, 0), vec(0, 1)]);
    const novelty = checkerboardNovelty(ssm, 2, 8);
    expect(novelty.length).toBe(2);
    expect(novelty[0]).toBe(0);
  });
});

describe("pickBoundaries", () => {
  it("always includes bar 0", () => {
    const flat = new Float32Array(20);
    expect(pickBoundaries(flat, 20, 4)).toEqual([0]);
  });
  it("picks a clear spike and respects minimum spacing between multiple spikes", () => {
    const novelty = new Float32Array(40);
    novelty[10] = 5;
    novelty[13] = 5.5; // within minSpacing of 10 → should lose to the stronger 13, not both kept
    novelty[30] = 6;
    const bounds = pickBoundaries(novelty, 40, 8);
    expect(bounds).toContain(0);
    expect(bounds).toContain(30);
    // 10 and 13 are both within 8 bars of each other AND of the eventual chosen set — only the
    // stronger of the close pair should survive.
    const near10 = bounds.filter((b) => b !== 0 && b !== 30);
    expect(near10.length).toBeLessThanOrEqual(1);
    if (near10.length === 1) expect(near10[0]).toBe(13);
  });
});

describe("labelSegments", () => {
  it("gives a repeated section the SAME letter as its first occurrence (ABAB)", () => {
    // 4 segments of 10 bars each: A B A B, where the two A's and two B's are near-identical
    // feature vectors and A/B are clearly distinct from each other.
    const vectors: Float32Array[] = [];
    for (let seg = 0; seg < 4; seg++) {
      const isA = seg % 2 === 0;
      for (let b = 0; b < 10; b++) {
        const jitter = ((seg * 37 + b) % 10) / 10000;
        vectors.push(isA ? vec(1 + jitter, 0.05, 0) : vec(0, 0.05, 1 + jitter));
      }
    }
    const ssm = buildSSM(vectors);
    const labels = labelSegments(ssm, 40, [0, 10, 20, 30]);
    expect(labels).toEqual(["A", "B", "A", "B"]);
  });
  it("labels a through-composed (no real repeats) track all-distinct", () => {
    const vectors: Float32Array[] = [];
    // 5 segments, each pointing in a mutually near-orthogonal direction in a 5-dim space.
    for (let seg = 0; seg < 5; seg++) {
      for (let b = 0; b < 6; b++) {
        const v = new Float32Array(5);
        v[seg] = 1;
        vectors.push(l2normalize(v));
      }
    }
    const ssm = buildSSM(vectors);
    const labels = labelSegments(ssm, 30, [0, 6, 12, 18, 24]);
    expect(new Set(labels).size).toBe(5);
    expect(labels).toEqual(["A", "B", "C", "D", "E"]);
  });
  it("never merges two ADJACENT segments even if they score identically similar", () => {
    // Two adjacent segments that are (by construction) maximally similar — should still get
    // different letters, because adjacency is excluded from matching regardless of score.
    const vectors: Float32Array[] = [];
    for (let b = 0; b < 20; b++) vectors.push(vec(1, 0.1, 0)); // one uniform "section" throughout
    const ssm = buildSSM(vectors);
    const labels = labelSegments(ssm, 20, [0, 10]);
    expect(labels[0]).not.toBe(labels[1]);
  });
  it("caps distinct letters at maxLetters on a track with many near-unique segments", () => {
    const vectors: Float32Array[] = [];
    const boundaries: number[] = [];
    for (let seg = 0; seg < 12; seg++) {
      boundaries.push(seg * 4);
      for (let b = 0; b < 4; b++) {
        const v = new Float32Array(12);
        v[seg] = 1; // every segment mutually near-orthogonal → nothing SHOULD cluster
        vectors.push(l2normalize(v));
      }
    }
    const ssm = buildSSM(vectors);
    const labels = labelSegments(ssm, 48, boundaries, 8);
    expect(new Set(labels).size).toBeLessThanOrEqual(8);
    expect(labels.length).toBe(12);
  });
  it("returns [] for zero boundaries and doesn't throw on a single segment", () => {
    expect(labelSegments(new Float32Array(0), 0, [])).toEqual([]);
    const ssm = buildSSM([vec(1, 0)]);
    expect(labelSegments(ssm, 1, [0])).toEqual(["A"]);
  });
});
