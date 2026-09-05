import { describe, it, expect } from "vitest";
import { sampleBands } from "./bandSample";
import type { PyramidLevel } from "./analyze";

// A synthetic LOD that alternates: bass-only buckets, then treble-only buckets. Every band still
// reaches 1.0 somewhere, which is exactly what per-band normalisation guarantees on real audio.
const BUCKET = 256;
const SR = 48000;
function alternating(nBuckets: number, run: number): PyramidLevel {
  const low = new Float32Array(nBuckets);
  const mid = new Float32Array(nBuckets);
  const high = new Float32Array(nBuckets);
  for (let i = 0; i < nBuckets; i++) {
    const bassPhase = Math.floor(i / run) % 2 === 0;
    low[i] = bassPhase ? 1 : 0.02;
    mid[i] = 0.25;
    high[i] = bassPhase ? 0.02 : 1;
  }
  return { bucket: BUCKET, min: new Float32Array(nBuckets), max: new Float32Array(nBuckets), low, mid, high };
}

/** Spread of the low band's SHARE across columns. High = the colour still varies with the music;
 *  near zero = every column reports the same mix, i.e. a uniform striped block. */
function lowShareSpread(lod: PyramidLevel, secPerPx: number, ow: number): number {
  const l = new Float32Array(ow), m = new Float32Array(ow), h = new Float32Array(ow);
  sampleBands(lod, SR, 0, secPerPx, ow, l, m, h);
  const shares: number[] = [];
  for (let x = 0; x < ow; x++) {
    const s = l[x] + m[x] + h[x];
    if (s > 1e-6) shares.push(l[x] / s);
  }
  const mean = shares.reduce((a, b) => a + b, 0) / shares.length;
  return Math.sqrt(shares.reduce((a, b) => a + (b - mean) ** 2, 0) / shares.length);
}

describe("sampleBands", () => {
  const N = 4096;
  const RUN = 8; // buckets per bass/treble phase
  const secPerBucket = BUCKET / SR;

  it("zoomed IN, one bucket per column, reports the bucket's own values", () => {
    // The mean over a single bucket IS that bucket. The close-up view is untouched by this
    // reduction — which is what makes it safe to change.
    const lod = alternating(N, RUN);
    const ow = 64;
    const l = new Float32Array(ow), m = new Float32Array(ow), h = new Float32Array(ow);
    sampleBands(lod, SR, 0, secPerBucket, ow, l, m, h);
    expect(l[0]).toBeCloseTo(lod.low[0], 6);
    expect(h[0]).toBeCloseTo(lod.high[0], 6);
  });

  it("keeps the colour VARYING when zoomed out over many buckets", () => {
    // THE DEFECT THIS GUARDS. With a peak-hold, a column spanning both a bass phase and a treble
    // phase reports low≈1 AND high≈1 — every column the same, so the overview paints as one flat
    // striped block right where it is meant to show you the arrangement.
    const lod = alternating(N, RUN);
    const zoomedIn = lowShareSpread(lod, secPerBucket, 256);
    const zoomedOut = lowShareSpread(lod, secPerBucket * 40, 256); // 40 buckets per column
    // Averaging cannot preserve ALL the detail — but it must not collapse to a constant.
    expect(zoomedIn).toBeGreaterThan(0.2);
    expect(zoomedOut).toBeGreaterThan(0.05);
  });

  it("a mean actually reports the mix, where a peak-hold would report ~1 for both bands", () => {
    // One column spanning exactly one bass run + one treble run. The truthful answer is that the
    // span is half bass and half treble; a peak-hold would say it is FULL of both.
    const lod = alternating(N, RUN);
    const ow = 4;
    const l = new Float32Array(ow), m = new Float32Array(ow), h = new Float32Array(ow);
    sampleBands(lod, SR, 0, secPerBucket * RUN * 2, ow, l, m, h);
    expect(l[0]).toBeLessThan(0.75); // a peak-hold would put this at 1.0
    expect(h[0]).toBeLessThan(0.75);
    expect(l[0]).toBeGreaterThan(0.2); // and it must not vanish either
  });

  it("zeroes columns that fall outside the track", () => {
    const lod = alternating(64, RUN);
    const ow = 8;
    const l = new Float32Array(ow), m = new Float32Array(ow), h = new Float32Array(ow);
    // start well past the end of the data
    sampleBands(lod, SR, 1000, secPerBucket, ow, l, m, h);
    expect(Array.from(l)).toEqual(new Array(ow).fill(0));
    expect(Array.from(h)).toEqual(new Array(ow).fill(0));
  });
});
