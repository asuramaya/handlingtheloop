import { describe, expect, it } from "vitest";
import { gateCycleLength } from "./GateFx";

// The GATE's beat alignment, tested where it can be tested: the cycle-length decision is pure, so
// the behaviour that matters — converge, never wobble, never lurch — is checkable without an
// AudioContext. (What is NOT covered here: that the scheduled ramps themselves are continuous;
// that is what fxlab's --live-audit measures on real output.)
const PULL = 0.12;

describe("gateCycleLength", () => {
  it("leaves a cycle that is already on the grid exactly one period long", () => {
    // An alignment that keeps nudging a locked gate is a permanent tempo wobble.
    const { len, err } = gateCycleLength(4, 0, 0.5, PULL);
    expect(len).toBeCloseTo(0.5, 12);
    expect(err).toBeCloseTo(0, 12);
  });

  it("shortens a late cycle and lengthens an early one", () => {
    const late = gateCycleLength(0.05, 0, 0.5, PULL); // started 0.05 s after the slot
    expect(late.len).toBeLessThan(0.5);
    const early = gateCycleLength(0.45, 0, 0.5, PULL); // 0.05 s BEFORE the next slot
    expect(early.len).toBeGreaterThan(0.5);
  });

  it("takes the short way round instead of chasing the slot it just left", () => {
    // 0.49 into a 0.5 s period is 0.01 EARLY for the next slot, not 0.49 late. Getting this
    // backwards drags the cycle almost all the way around the clock.
    const { err } = gateCycleLength(0.49, 0, 0.5, PULL);
    expect(err).toBeCloseTo(-0.02, 6); // −2% of a cycle
    expect(gateCycleLength(0.49, 0, 0.5, PULL).len).toBeGreaterThan(0.5);
  });

  it("never stretches a single cycle past the pull limit", () => {
    // The worst case is half a cycle out; the correction must still be inaudible per cycle.
    for (const start of [0.25, 0.2499, 0.2501, 0.0, 0.4999]) {
      const { len } = gateCycleLength(start, 0, 0.5, PULL);
      expect(Math.abs(len - 0.5)).toBeLessThanOrEqual(0.5 * PULL + 1e-12);
    }
  });

  it("converges from the worst case within a handful of cycles", () => {
    const period = 0.5;
    let t = 0.24; // just short of half a cycle out
    let err = 1;
    let n = 0;
    while (n < 12) {
      const r = gateCycleLength(t, 0, period, PULL);
      err = Math.abs(r.err);
      if (err < 0.02) break;
      t += r.len;
      n++;
    }
    expect(err).toBeLessThan(0.02);
    expect(n).toBeLessThanOrEqual(6);
  });

  it("puts the grid slot where SHIFT says, not where the bar line is", () => {
    // shift 0.5 = the offbeat gate: a cycle landing on the bar line is now HALF a cycle out.
    const period = 0.5;
    const origin = 0 + 0.5 * period;
    const { err } = gateCycleLength(0, origin, period, PULL);
    expect(Math.abs(err)).toBeCloseTo(0.5, 6);
  });

  it("survives a degenerate period instead of returning NaN", () => {
    expect(gateCycleLength(1, 0, 0, PULL).err).toBe(0);
  });
});
