import { describe, it, expect } from "vitest";
import { makeRectifyCurve, makeClampCurve } from "./duckingHelper";

const N = 1024;

describe("makeRectifyCurve", () => {
  it("has length 1024", () => {
    expect(makeRectifyCurve().length).toBe(N);
  });
  it("maps the curve domain [-1,1] to |x|", () => {
    const c = makeRectifyCurve();
    // endpoints: i=0 -> x=-1 -> |−1|=1 ; i=N-1 -> x=1 -> 1
    expect(c[0]).toBeCloseTo(1, 6);
    expect(c[N - 1]).toBeCloseTo(1, 6);
    // center: i where x≈0 is the minimum, ≈0
    const mid = Math.round((N - 1) / 2);
    expect(c[mid]).toBeLessThan(0.01);
  });
  it("equals |x| for the input it represents at every index", () => {
    const c = makeRectifyCurve();
    for (let i = 0; i < N; i += 37) {
      const x = (i / (N - 1)) * 2 - 1;
      expect(c[i]).toBeCloseTo(Math.abs(x), 6);
    }
  });
  it("is non-negative everywhere", () => {
    const c = makeRectifyCurve();
    for (let i = 0; i < N; i++) expect(c[i]).toBeGreaterThanOrEqual(0);
  });
});

describe("makeClampCurve", () => {
  it("has length 1024", () => {
    expect(makeClampCurve().length).toBe(N);
  });
  it("maps to [0,1]: negative-x half is 0, positive-x half is x", () => {
    const c = makeClampCurve();
    // i=0 -> x=-1 -> clamp -> 0
    expect(c[0]).toBe(0);
    // i=N-1 -> x=1 -> 1
    expect(c[N - 1]).toBeCloseTo(1, 6);
  });
  it("equals max(0, min(1, x)) at every index", () => {
    const c = makeClampCurve();
    for (let i = 0; i < N; i += 31) {
      const x = (i / (N - 1)) * 2 - 1;
      expect(c[i]).toBeCloseTo(Math.max(0, Math.min(1, x)), 6);
    }
  });
  it("is bounded within [0,1] and monotonic non-decreasing", () => {
    const c = makeClampCurve();
    let prev = -Infinity;
    for (let i = 0; i < N; i++) {
      expect(c[i]).toBeGreaterThanOrEqual(0);
      expect(c[i]).toBeLessThanOrEqual(1);
      expect(c[i]).toBeGreaterThanOrEqual(prev);
      prev = c[i];
    }
  });
});
