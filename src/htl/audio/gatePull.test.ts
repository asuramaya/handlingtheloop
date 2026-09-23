import { describe, expect, it } from "vitest";

// GateFx.PULL_MAX had a justification imported from the sync engine's RATE trim — "under the ~5%
// that reads as a tempo wobble on a sustained tone" — which is arithmetically false (12 > 5) and
// describes an artifact this device cannot produce, because it modulates gain and never rate.
//
// The half that WAS right is the convergence bound, and it is pure arithmetic, so it is pinned
// here: the constant's lower limit is set by how fast the gate can walk onto the beat.

/** Cycles needed to absorb a worst-case error of half a cycle at a given per-cycle pull. */
const cyclesToConverge = (pullMax: number) => 0.5 / pullMax;

describe("gate pull convergence", () => {
  it("12% absorbs a worst-case half-cycle error in about four cycles", () => {
    expect(cyclesToConverge(0.12)).toBeCloseTo(4.17, 2);
  });

  it("5% — the figure the old comment wrongly compared against — takes ten", () => {
    expect(cyclesToConverge(0.05)).toBeCloseTo(10, 6);
  });

  it("so the borrowed bound would have cost more than a bar on a 1/8 gate", () => {
    // A 1/8 division puts 8 gate cycles in a bar, so ten cycles is over one bar of visible walking.
    expect(cyclesToConverge(0.05)).toBeGreaterThan(8);
    expect(cyclesToConverge(0.12)).toBeLessThan(8);
  });

  it("convergence is monotonic in the pull — a bigger budget cannot converge slower", () => {
    let prev = Infinity;
    for (let p = 0.02; p <= 0.3; p += 0.01) {
      const c = cyclesToConverge(p);
      expect(c).toBeLessThanOrEqual(prev);
      prev = c;
    }
  });

  it("CONTROL: the formula is not constant, or every case above passes vacuously", () => {
    expect(cyclesToConverge(0.12)).not.toBeCloseTo(cyclesToConverge(0.05), 3);
  });
});
