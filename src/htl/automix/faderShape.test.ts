import { describe, expect, test } from "vitest";
import { cutPoint, faderX } from "./autoMixer";

// The fader as a function of the transition (0 = all outgoing, 1 = all incoming). See faderX.
describe("faderX", () => {
  test("a beat-matched blend comes in early and goes out late (not a straight fade)", () => {
    const at = (p: number) => faderX("blend", p, 32, 16, true);
    expect(at(0)).toBe(0);
    expect(at(0.25)).toBeCloseTo(0.5, 6); // both decks up by the end of the first quarter
    expect(at(0.5)).toBeCloseTo(0.5, 6); // …and held there through the bass swap
    expect(at(0.7)).toBeCloseTo(0.5, 6); // the outgoing keeps its level into the last phrase
    expect(at(1)).toBeCloseTo(1, 6);
    // never moves backwards
    let prev = -1;
    for (let i = 0; i <= 100; i++) {
      const x = at(i / 100);
      expect(x).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = x;
    }
  });

  test("a cut is a cut: nothing, then everything, on its last bar", () => {
    expect(faderX("cut", 0.7, 4, 0, true)).toBe(0);
    expect(faderX("cut", 0.76, 4, 0, true)).toBe(1);
  });

  test("an unmatched pair moves the fader once, at the cut — never before it", () => {
    for (const style of ["echoOut", "washOut", "spinOut", "dropSwap", "cut"] as const) {
      const cut = cutPoint(style, 4);
      expect(faderX(style, cut - 0.01, 4, 0, false)).toBe(0);
      expect(faderX(style, cut + 0.001, 4, 0, false)).toBeGreaterThanOrEqual(0.5);
      expect(faderX(style, 1, 4, 0, false)).toBeCloseTo(1, 6);
    }
  });

  test("gestures written against a straight line keep it", () => {
    expect(faderX("gateChop", 0.3, 16, 8, true)).toBeCloseTo(0.3, 6);
  });
});
