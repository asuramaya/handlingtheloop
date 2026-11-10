import { describe, expect, it } from "vitest";
import { StemPacker, PACK_BUCKET, opusPacketSamples48k } from "./stemPack";

// The pre-streaming pack (index.ts packStemInt16Full, verbatim math): a WHOLE decoded stem in one
// call, output sized to the set's length N. The streaming packer must reproduce it exactly — the
// int16 is what the worklet plays, so "close" is not good enough.
function referencePack(fL: Float32Array, fR: Float32Array, N: number, sr: number) {
  const oL = new Int16Array(N);
  const oR = new Int16Array(N);
  const n = Math.min(fL.length, N);
  const buckets = Math.ceil(N / PACK_BUCKET);
  const min = new Float32Array(buckets);
  const max = new Float32Array(buckets);
  const low = new Float32Array(buckets);
  const mid = new Float32Array(buckets);
  const high = new Float32Array(buckets);
  const aLow = 1 - Math.exp((-2 * Math.PI * 200) / sr);
  const aMid = 1 - Math.exp((-2 * Math.PI * 2000) / sr);
  let lp200 = 0, lp2000 = 0, lSum = 0, mSum = 0, hSum = 0;
  let maxLow = 1e-9, maxMid = 1e-9, maxHigh = 1e-9, bMin = 1, bMax = -1, cnt = 0, bi = 0;
  for (let i = 0; i < n; i++) {
    const l = fL[i];
    const r = fR[i];
    const sl = l * 32767;
    const srr = r * 32767;
    oL[i] = sl < -32767 ? -32767 : sl > 32767 ? 32767 : Math.round(sl);
    oR[i] = srr < -32767 ? -32767 : srr > 32767 ? 32767 : Math.round(srr);
    const mm = (l + r) * 0.5;
    lp200 += aLow * (mm - lp200);
    lp2000 += aMid * (mm - lp2000);
    const lo = lp200, md = lp2000 - lp200, hi = mm - lp2000;
    if (mm < bMin) bMin = mm;
    if (mm > bMax) bMax = mm;
    lSum += lo * lo; mSum += md * md; hSum += hi * hi;
    if (++cnt >= PACK_BUCKET || i === n - 1) {
      const lv = Math.sqrt(lSum / cnt), mv = Math.sqrt(mSum / cnt), hv = Math.sqrt(hSum / cnt);
      min[bi] = bMin; max[bi] = bMax; low[bi] = lv; mid[bi] = mv; high[bi] = hv;
      if (lv > maxLow) maxLow = lv;
      if (mv > maxMid) maxMid = mv;
      if (hv > maxHigh) maxHigh = hv;
      bi++; bMin = 1; bMax = -1; lSum = mSum = hSum = 0; cnt = 0;
    }
  }
  for (let i = 0; i < buckets; i++) { low[i] /= maxLow; mid[i] /= maxMid; high[i] /= maxHigh; }
  return { L: oL, R: oR, min, max, low, mid, high };
}

function noise(n: number, seed: number) {
  const a = new Float32Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) % 2147483648;
    a[i] = (x / 2147483648) * 2.4 - 1.2; // overshoots ±1 so the clamp is exercised
  }
  return a;
}

/** Feed the packer in decoder-sized chunks (Opus frames are 960 samples; vary it to hit bucket edges). */
function packChunked(fL: Float32Array, fR: Float32Array, sr: number, capacity: number, limit?: number) {
  const p = new StemPacker(sr, capacity, limit);
  const sizes = [960, 37, 256, 1, 2048, 960];
  for (let o = 0, k = 0; o < fL.length; k++) {
    const c = Math.min(sizes[k % sizes.length], fL.length - o);
    p.push(fL.subarray(o, o + c), fR.subarray(o, o + c), c);
    o += c;
  }
  return p.finish();
}

describe("StemPacker — streaming pack is bit-identical to the whole-buffer pack", () => {
  const sr = 48000;
  it("first stem of a set: length = samples pushed, capacity estimate too LOW (grows)", () => {
    const n = 50_000 + 123;
    const fL = noise(n, 1), fR = noise(n, 2);
    const ref = referencePack(fL, fR, n, sr);
    const got = packChunked(fL, fR, sr, 10_000);
    expect(got.length).toBe(n);
    expect(Array.from(got.L)).toEqual(Array.from(ref.L));
    expect(Array.from(got.R)).toEqual(Array.from(ref.R));
    for (const k of ["min", "max", "low", "mid", "high"] as const) expect(Array.from(got.base[k])).toEqual(Array.from(ref[k]));
  });
  it("capacity estimate too HIGH: output views are trimmed to the real length", () => {
    const n = 7 * PACK_BUCKET; // exact bucket multiple — the last bucket must not be flushed twice
    const fL = noise(n, 3), fR = noise(n, 4);
    const ref = referencePack(fL, fR, n, sr);
    const got = packChunked(fL, fR, sr, n + 5000);
    expect(got.L.length).toBe(n);
    expect(got.base.min.length).toBe(7);
    expect(Array.from(got.L)).toEqual(Array.from(ref.L));
    for (const k of ["min", "max", "low", "mid", "high"] as const) expect(Array.from(got.base[k])).toEqual(Array.from(ref[k]));
  });
  it("a later stem SHORTER than the set is silence-padded to the limit", () => {
    const N = 20_000, n = 18_500;
    const fL = noise(n, 5), fR = noise(n, 6);
    const ref = referencePack(fL, fR, N, sr);
    const got = packChunked(fL, fR, sr, 0, N);
    expect(got.length).toBe(N);
    expect(Array.from(got.L)).toEqual(Array.from(ref.L));
    for (const k of ["min", "max", "low", "mid", "high"] as const) expect(Array.from(got.base[k])).toEqual(Array.from(ref[k]));
  });
  it("a later stem LONGER than the set is truncated to the limit", () => {
    const N = 20_000, n = 21_000;
    const fL = noise(n, 7), fR = noise(n, 8);
    const ref = referencePack(fL, fR, N, sr);
    const got = packChunked(fL, fR, sr, 0, N);
    expect(got.length).toBe(N);
    expect(Array.from(got.R)).toEqual(Array.from(ref.R));
    for (const k of ["min", "max", "low", "mid", "high"] as const) expect(Array.from(got.base[k])).toEqual(Array.from(ref[k]));
  });
  it("mono (same plane twice) matches", () => {
    const n = 3000;
    const f = noise(n, 9);
    const ref = referencePack(f, f, n, 44100);
    const got = packChunked(f, f, 44100, n);
    expect(Array.from(got.L)).toEqual(Array.from(ref.L));
    expect(Array.from(got.base.high)).toEqual(Array.from(ref.high));
  });
});

describe("opusPacketSamples48k — sizes the int16 output before decoding", () => {
  it("reads the TOC frame size and frame count", () => {
    // CELT 20 ms (config 31), one frame — what WebCodecs' Opus encoder emits by default.
    expect(opusPacketSamples48k(new Uint8Array([(31 << 3) | 0]))).toBe(960);
    // CELT 10 ms, two frames (code 1).
    expect(opusPacketSamples48k(new Uint8Array([(30 << 3) | 1]))).toBe(960);
    // SILK 60 ms (config 3), one frame.
    expect(opusPacketSamples48k(new Uint8Array([(3 << 3) | 0]))).toBe(2880);
    // Hybrid 20 ms (config 13), code 3 with 3 frames.
    expect(opusPacketSamples48k(new Uint8Array([(13 << 3) | 3, 3]))).toBe(2880);
    expect(opusPacketSamples48k(new Uint8Array([]))).toBe(0);
  });
});
