import { describe, expect, it } from "vitest";
import { scratchOffset, type ScratchKind } from "./scratchPatterns";

// The FX2 scratch curves: record offset in beats vs beats elapsed. Speed is the slope; a flat
// stretch is a still (silent) record.
const at = (k: ScratchKind, b: number) => scratchOffset(k, b);
const slope = (k: ScratchKind, b: number, h = 1e-4) => (at(k, b + h) - at(k, b - h)) / (2 * h);
const KINDS: ScratchKind[] = ["baby", "drag", "scribble", "hydro", "tear", "stab"];

describe("scratch patterns", () => {
  it("every curve is continuous — a hand never teleports the record", () => {
    for (const k of KINDS)
      for (let b = 0; b < 4; b += 0.001) expect(Math.abs(at(k, b + 0.001) - at(k, b))).toBeLessThan(0.02);
  });

  it("BABY goes forward and back once per beat; DRAG pulls BACK over two", () => {
    expect(at("baby", 0)).toBeCloseTo(0, 6);
    expect(at("baby", 0.5)).toBeGreaterThan(0.3);
    expect(at("baby", 1)).toBeCloseTo(0, 6);
    expect(at("drag", 1)).toBeLessThan(-0.4);
    expect(at("drag", 2)).toBeCloseTo(0, 6);
  });

  it("SCRIBBLE buzzes in place; HYDROPLANE buzzes while travelling one beat per beat", () => {
    expect(Math.abs(at("scribble", 3.37))).toBeLessThan(0.04);
    expect(at("hydro", 3) - at("hydro", 2)).toBeCloseTo(1, 6);
  });

  it("TEAR has still gaps between its three pushes, then returns home", () => {
    expect(slope("tear", 0.175)).toBeCloseTo(0, 6); // the gap after push 1
    expect(slope("tear", 0.375)).toBeCloseTo(0, 6); // after push 2
    expect(slope("tear", 0.1)).toBeGreaterThan(0); // pushing
    expect(at("tear", 0.6)).toBeCloseTo(0.3, 6); // the full stroke
    expect(at("tear", 0.999)).toBeLessThan(0.01); // back home
  });

  it("STAB is a short push then stillness, walking forward a hit at a time", () => {
    expect(slope("stab", 0.5)).toBeCloseTo(0, 6);
    expect(slope("stab", 0.07)).toBeGreaterThan(0.5);
    expect(at("stab", 2.5) - at("stab", 1.5)).toBeCloseTo(0.12, 6);
  });
});
