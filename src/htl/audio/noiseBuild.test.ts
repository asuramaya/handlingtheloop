import { describe, expect, it } from "vitest";
import { noiseBuildEnd, noiseEase } from "./NoiseFx";

// The riser's build SHAPE. It is the device's whole character — a late bloom and a front-loaded
// leap are different musical events on the same 8 bars — so the curve gets pinned down here,
// where it can be checked without an AudioContext.
describe("noiseEase", () => {
  it("runs 0 → 1 over the build, whatever the shape", () => {
    for (const curve of [0, 0.25, 0.5, 0.75, 1]) {
      expect(noiseEase(0, curve)).toBeCloseTo(0, 10);
      expect(noiseEase(1, curve)).toBeCloseTo(1, 10);
    }
  });

  it("is linear at the centre detent", () => {
    for (const p of [0.1, 0.25, 0.5, 0.75, 0.9]) expect(noiseEase(p, 0.5)).toBeCloseTo(p, 6);
  });

  it("holds back then rushes below centre, and leaps then eases above it", () => {
    // At the halfway point: a late bloom is still low, a front-loaded build is already high.
    expect(noiseEase(0.5, 0)).toBeLessThan(0.35);
    expect(noiseEase(0.5, 1)).toBeGreaterThan(0.65);
  });

  it("never goes backwards — a riser that dips is a broken riser", () => {
    for (const curve of [0, 0.3, 0.5, 0.7, 1]) {
      let prev = -1;
      for (let i = 0; i <= 64; i++) {
        const v = noiseEase(i / 64, curve);
        expect(v).toBeGreaterThanOrEqual(prev);
        prev = v;
      }
    }
  });

  it("clamps out-of-range progress instead of running away", () => {
    expect(noiseEase(-1, 0.5)).toBe(0);
    expect(noiseEase(2, 0.5)).toBe(1);
  });
});

// SNAP — the riser's reason to exist. A build that ends "wherever my finger landed plus eight
// bars" is not a transition; these pin down that it lands on the grid, and that landing never
// costs more than half a bar of stretch.
describe("noiseBuildEnd", () => {
  const bar = 2; // 120 bpm, 4/4
  const grid = { at: 0, bar };
  const nominal = 4 * bar; // a 4-bar build

  it("returns the nominal length when there is no grid to land on", () => {
    expect(noiseBuildEnd(1.234, nominal, null, bar / 2)).toBe(nominal);
    expect(noiseBuildEnd(1.234, nominal, { at: 0, bar: 0 }, bar / 2)).toBe(nominal);
  });

  it("lands on a bar line however ragged the press", () => {
    for (const press of [0, 0.17, 0.4, 0.73, 0.95, 1.5, 3.99]) {
      const t = press * bar;
      const end = t + noiseBuildEnd(t, nominal, grid, bar / 2);
      expect(Math.abs(end / bar - Math.round(end / bar))).toBeLessThan(1e-9);
    }
  });

  it("never stretches the build by more than half a bar to get there", () => {
    for (let i = 0; i < 40; i++) {
      const t = (i / 40) * bar * 3;
      const dur = noiseBuildEnd(t, nominal, grid, bar / 2);
      expect(Math.abs(dur - nominal)).toBeLessThanOrEqual(bar / 2 + 1e-9);
    }
  });

  it("refuses to collapse a build into a click", () => {
    // Nominal so short that the nearest line is essentially underfoot.
    const dur = noiseBuildEnd(1.999, 0.05, grid, bar / 2);
    expect(dur).toBeGreaterThanOrEqual(bar / 2);
  });

  it("honours a grid whose bar lines are not at zero", () => {
    const offsetGrid = { at: 0.37, bar };
    const t = 5.1;
    const end = t + noiseBuildEnd(t, nominal, offsetGrid, bar / 2);
    const k = (end - offsetGrid.at) / bar;
    expect(Math.abs(k - Math.round(k))).toBeLessThan(1e-9);
  });
});
