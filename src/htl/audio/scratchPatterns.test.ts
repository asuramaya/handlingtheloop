import { describe, expect, it } from "vitest";
import { scratchOffset, type ScratchKind } from "./scratchPatterns";

// The FX2 platter curves (DRAG · PUSH · RUB): record offset in beats vs beats since the press.
// Speed is the slope.
const at = (k: ScratchKind, b: number) => scratchOffset(k, b);
const slope = (k: ScratchKind, b: number, h = 1e-4) => (at(k, b + h) - at(k, b - h)) / (2 * h);
const KINDS: ScratchKind[] = ["drag", "push", "rub"];

describe("platter patterns", () => {
  it("every curve is continuous — a hand never teleports the record", () => {
    for (const k of KINDS)
      for (let b = 0; b < 4; b += 0.001) expect(Math.abs(at(k, b + 0.001) - at(k, b))).toBeLessThan(0.02);
  });

  it("DRAG pulls back one beat, then lets the record play: it stays exactly a beat behind", () => {
    expect(at("drag", 0)).toBeCloseTo(0, 6);
    expect(slope("drag", 0.25)).toBeLessThan(0); // pulling back
    expect(at("drag", 3) - 3).toBeCloseTo(-1, 6); // a beat behind where it would be
    expect(slope("drag", 2)).toBeCloseTo(1, 6); // playing on at speed
  });

  it("PUSH shoves forward one beat, then lets the record play: exactly a beat ahead", () => {
    expect(slope("push", 0.1)).toBeGreaterThan(1); // a fast shove
    expect(at("push", 3) - 3).toBeCloseTo(1, 6);
    expect(slope("push", 2)).toBeCloseTo(1, 6);
  });

  it("RUB rubs back and forth on the spot, twice a beat", () => {
    expect(Math.abs(at("rub", 2.37))).toBeLessThan(0.09);
    expect(at("rub", 0.5)).toBeCloseTo(at("rub", 0), 6);
  });
});
