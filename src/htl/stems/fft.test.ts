import { describe, it, expect } from "vitest";
import { FFT, hannPeriodic, reflectPad } from "./fft";

// ── Scaling convention (read from transform()): forward (inv=false) applies NO
// normalization; inverse (inv=true) divides every sample by N. So a forward
// followed by an inverse recovers the original WITHOUT any manual 1/N.

function makeRe(arr: number[]): Float32Array {
  return Float32Array.from(arr);
}

describe("FFT round-trip", () => {
  for (const N of [8, 16, 32]) {
    it(`forward then inverse recovers the signal (N=${N})`, () => {
      const re = new Float32Array(N);
      const im = new Float32Array(N);
      for (let i = 0; i < N; i++) re[i] = Math.sin((2 * Math.PI * 3 * i) / N) + 0.5 * (i % 5);
      const re0 = re.slice();
      const im0 = im.slice();
      const fft = new FFT(N);
      fft.transform(re, im, false);
      fft.transform(re, im, true); // inverse divides by N internally
      for (let i = 0; i < N; i++) {
        expect(re[i]).toBeCloseTo(re0[i], 4);
        expect(im[i]).toBeCloseTo(im0[i], 4);
      }
    });
  }
});

describe("FFT impulse → flat magnitude spectrum", () => {
  it("impulse [1,0,0,...] yields all-ones real spectrum, zero imag", () => {
    const N = 8;
    const re = makeRe([1, 0, 0, 0, 0, 0, 0, 0]);
    const im = new Float32Array(N);
    new FFT(N).transform(re, im, false);
    for (let k = 0; k < N; k++) {
      expect(re[k]).toBeCloseTo(1, 5);
      expect(im[k]).toBeCloseTo(0, 5);
      const mag = Math.hypot(re[k], im[k]);
      expect(mag).toBeCloseTo(1, 5);
    }
  });
});

describe("FFT single-bin cosine → energy at that bin", () => {
  it("cos(2π·k0·n/N) puts energy at bins k0 and N-k0 only", () => {
    const N = 16;
    const k0 = 3;
    const re = new Float32Array(N);
    const im = new Float32Array(N);
    for (let n = 0; n < N; n++) re[n] = Math.cos((2 * Math.PI * k0 * n) / N);
    new FFT(N).transform(re, im, false);
    const mag = Array.from({ length: N }, (_, k) => Math.hypot(re[k], im[k]));
    // A real cosine of amplitude 1 → magnitude N/2 at k0 and N-k0.
    expect(mag[k0]).toBeCloseTo(N / 2, 3);
    expect(mag[N - k0]).toBeCloseTo(N / 2, 3);
    // every other bin is ~0
    for (let k = 0; k < N; k++) {
      if (k === k0 || k === N - k0) continue;
      expect(mag[k]).toBeLessThan(1e-3);
    }
  });
});

describe("FFT constructor", () => {
  it("throws on non-power-of-two size", () => {
    expect(() => new FFT(6)).toThrow(/power of two/);
    expect(() => new FFT(12)).toThrow();
  });
  it("accepts powers of two", () => {
    expect(() => new FFT(1)).not.toThrow();
    expect(() => new FFT(2)).not.toThrow();
    expect(new FFT(8).n).toBe(8);
  });
});

describe("hannPeriodic", () => {
  it("has length n", () => {
    expect(hannPeriodic(8).length).toBe(8);
    expect(hannPeriodic(16).length).toBe(16);
  });
  it("starts at 0 (periodic, NOT symmetric)", () => {
    const w = hannPeriodic(8);
    expect(w[0]).toBeCloseTo(0, 6);
  });
  it("peaks at the center (== 1 for even n)", () => {
    const n = 8;
    const w = hannPeriodic(n);
    expect(w[n / 2]).toBeCloseTo(1, 6); // 0.5 - 0.5*cos(π) = 1
    // center is the maximum
    for (let i = 0; i < n; i++) expect(w[i]).toBeLessThanOrEqual(w[n / 2] + 1e-9);
  });
  it("is periodic: last sample is NOT zero (unlike symmetric Hann)", () => {
    const w = hannPeriodic(8);
    // w[7] = 0.5 - 0.5*cos(2π·7/8) = 0.5 - 0.5*cos(7π/4) ≈ 0.1464
    expect(w[7]).toBeCloseTo(0.5 - 0.5 * Math.cos((2 * Math.PI * 7) / 8), 6);
    expect(w[7]).toBeGreaterThan(0);
  });
  it("matches the explicit formula at every index", () => {
    const n = 16;
    const w = hannPeriodic(n);
    for (let i = 0; i < n; i++) {
      expect(w[i]).toBeCloseTo(0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n), 6);
    }
  });
});

describe("reflectPad (numpy reflect, no edge repeat)", () => {
  it("[1,2,3,4] pad 2 → [3,2,1,2,3,4,3,2]", () => {
    const out = reflectPad(Float32Array.from([1, 2, 3, 4]), 2);
    expect(Array.from(out)).toEqual([3, 2, 1, 2, 3, 4, 3, 2]);
  });
  it("pad 1 reflects a single sample on each side", () => {
    const out = reflectPad(Float32Array.from([1, 2, 3, 4]), 1);
    // left: out[0]=x[1]=2 ; right: out[5]=x[2]=3
    expect(Array.from(out)).toEqual([2, 1, 2, 3, 4, 3]);
  });
  it("pad 0 returns a copy of the input", () => {
    const out = reflectPad(Float32Array.from([1, 2, 3, 4]), 0);
    expect(Array.from(out)).toEqual([1, 2, 3, 4]);
  });
  it("output length is n + 2*pad", () => {
    expect(reflectPad(Float32Array.from([1, 2, 3, 4, 5]), 3).length).toBe(5 + 6);
  });
});
