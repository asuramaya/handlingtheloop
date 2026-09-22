import { describe, it, expect } from "vitest";
import { envelope, pickLevel } from "./waveformEnvelope";
import type { Pyramid, PyramidLevel } from "@htl/analysis";

// A remote stem lane as it actually arrives: ONE coarse min/max level, no raw PCM, the geometry
// (length / sampleRate / bucket) described by the host in the view header. `carried` is how many
// buckets the lane really holds, which is NOT always what `length` claims — see the mis-described
// case below, which is the 2026-09-15 report's proposed mechanism (thread f2b8f545).
function remoteLane(opts: { seconds: number; sampleRate: number; bucket: number; carried?: number }): Pyramid {
  const length = Math.round(opts.seconds * opts.sampleRate);
  const n = opts.carried ?? Math.ceil(length / opts.bucket);
  const min = new Float32Array(n);
  const max = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    // Never zero: a real stem is loud everywhere here, so any flat pixel is the MAPPING, not the
    // material. Without this the test could not tell a collapse from a quiet passage.
    min[i] = -0.5 - 0.2 * Math.sin(i / 50);
    max[i] = 0.5 + 0.2 * Math.sin(i / 50);
  }
  const level: PyramidLevel = { bucket: opts.bucket, min, max, low: new Float32Array(n), mid: new Float32Array(n), high: new Float32Array(n) };
  return { sampleRate: opts.sampleRate, length, levels: [level] };
}

/** Sweep the whole track and report the first fraction of it that draws FLAT (lo === hi === 0). */
function firstFlatFraction(py: Pyramid, zoomSeconds: number, ow = 400): number | null {
  const duration = py.length / py.sampleRate;
  for (let start = 0; start < duration; start += zoomSeconds) {
    const secPerPx = zoomSeconds / ow;
    const lo = new Float32Array(ow);
    const hi = new Float32Array(ow);
    const lod = pickLevel(py, secPerPx * py.sampleRate);
    envelope(null, null, py.sampleRate, start, secPerPx, ow, lo, hi, lod);
    for (let x = 0; x < ow; x++) {
      const t = start + x * secPerPx;
      if (t >= duration) return null; // past the end: flat is the CORRECT answer, not a defect
      if (lo[x] === 0 && hi[x] === 0) return t / duration;
    }
  }
  return null;
}

describe("remote stem lane, sub-bucket zoom (thread f2b8f545)", () => {
  // The shipped geometry: a 200 s track at 44.1k, coarsened to a 2048-sample bucket the way
  // Deck.extractStemView picks it. A 2 s window is far inside the sub-bucket branch.
  const honest = remoteLane({ seconds: 200, sampleRate: 44100, bucket: 2048 });

  it("is actually exercising the sub-bucket interpolation branch, not the bucket-min/max loop", () => {
    const secPerPx = 2 / 400;
    expect(secPerPx * honest.sampleRate).toBeLessThan(2048); // spp < B — the branch under test
  });

  it("NEVER draws flat before the end of a correctly-described lane", () => {
    expect(firstFlatFraction(honest, 2)).toBeNull();
  });

  it("holds at the coarse end too, where the bucket-min/max loop runs instead", () => {
    expect(firstFlatFraction(honest, 400)).toBeNull();
  });

  it("covers the last pixel of the track — the envelope must not end early by one bucket", () => {
    const duration = honest.length / honest.sampleRate;
    const lo = new Float32Array(1);
    const hi = new Float32Array(1);
    envelope(null, null, honest.sampleRate, duration - 0.001, 0.001, 1, lo, hi, honest.levels[0]);
    expect(hi[0]).toBeGreaterThan(0);
  });

  // ★ THE CONTROL, and it is the reported defect. The view ships ONE length/bucket for all four
  // stems; a lane that carries fewer buckets than that header claims runs off the end of its own
  // data EARLY, and every pixel after that point zero-fills — a flat trace from there to the end of
  // the track. This is what setRemoteStemView's lane warning says will happen, so it had better.
  it("a lane carrying half the buckets its header claims collapses at half the track", () => {
    const short = remoteLane({ seconds: 200, sampleRate: 44100, bucket: 2048, carried: Math.ceil(Math.round(200 * 44100) / 2048 / 2) });
    const at = firstFlatFraction(short, 2);
    expect(at).not.toBeNull();
    expect(at!).toBeGreaterThan(0.45);
    expect(at!).toBeLessThan(0.55);
  });

  // The sample rate travels WITH the envelope (py.sampleRate), so a host at 44.1k and a guest at
  // 48k must not shift the mapping. If a caller ever passed the guest's context rate instead, the
  // lane would run off the end at ~92% — this pins which rate is the right one.
  it("is mapped by the envelope's OWN sample rate, so a 44.1k host on a 48k guest still fills", () => {
    const hostRate = remoteLane({ seconds: 200, sampleRate: 44100, bucket: 2048 });
    expect(firstFlatFraction(hostRate, 2)).toBeNull();
    const wrongRate = 48000 / 44100;
    const lo = new Float32Array(400);
    const hi = new Float32Array(400);
    // Deliberately mis-mapped: the guest's rate against the host's envelope, near the end.
    envelope(null, null, 44100 * wrongRate, 199, 2 / 400, 400, lo, hi, hostRate.levels[0]);
    expect(hi.some((v) => v === 0)).toBe(true); // the failure this guards against is reachable
  });
});
