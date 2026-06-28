import { describe, it, expect } from "vitest";
import { clamp, clamp01, lerp } from "./math";

describe("clamp", () => {
  it("returns lo when v is below the range", () => {
    expect(clamp(-5, 0, 10)).toBe(0);
    expect(clamp(0, 1, 10)).toBe(1);
  });
  it("returns v when within the range", () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(0, 0, 10)).toBe(0); // inclusive lower
    expect(clamp(10, 0, 10)).toBe(10); // inclusive upper
  });
  it("returns hi when v is above the range", () => {
    expect(clamp(50, 0, 10)).toBe(10);
  });
  it("handles negative ranges", () => {
    expect(clamp(-15, -10, -1)).toBe(-10);
    expect(clamp(0, -10, -1)).toBe(-1);
    expect(clamp(-5, -10, -1)).toBe(-5);
  });
  // With lo > hi the implementation is Math.max(lo, Math.min(hi, v)),
  // which collapses to lo for all v (Math.min(hi,v) <= hi < lo).
  it("collapses to lo when lo > hi (degenerate range)", () => {
    expect(clamp(5, 10, 0)).toBe(10);
    expect(clamp(-100, 10, 0)).toBe(10);
    expect(clamp(100, 10, 0)).toBe(10);
  });
});

describe("clamp01", () => {
  it("clamps below 0 to 0", () => {
    expect(clamp01(-0.5)).toBe(0);
    expect(clamp01(-100)).toBe(0);
  });
  it("passes values within [0,1]", () => {
    expect(clamp01(0)).toBe(0);
    expect(clamp01(0.5)).toBe(0.5);
    expect(clamp01(1)).toBe(1);
  });
  it("clamps above 1 to 1", () => {
    expect(clamp01(1.5)).toBe(1);
    expect(clamp01(100)).toBe(1);
  });
});

describe("lerp", () => {
  it("returns a at t=0", () => {
    expect(lerp(10, 20, 0)).toBe(10);
    expect(lerp(-5, 5, 0)).toBe(-5);
  });
  it("returns b at t=1", () => {
    expect(lerp(10, 20, 1)).toBe(20);
    expect(lerp(-5, 5, 1)).toBe(5);
  });
  it("returns the midpoint at t=0.5", () => {
    expect(lerp(10, 20, 0.5)).toBe(15);
    expect(lerp(-5, 5, 0.5)).toBe(0);
  });
  it("extrapolates beyond [0,1] (t is NOT clamped)", () => {
    expect(lerp(0, 10, 2)).toBe(20);
    expect(lerp(0, 10, -1)).toBe(-10);
    expect(lerp(10, 20, 1.5)).toBe(25);
  });
});
