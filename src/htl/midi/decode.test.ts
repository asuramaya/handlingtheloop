import { describe, it, expect } from "vitest";
import { centeredDelta, twosComplementDelta, wrappingStep } from "./decode";

const ALL = Array.from({ length: 128 }, (_, i) => i); // every 7-bit value 0..127

// Jog / bend / search / zoom: relative tick centred on 0x40.
describe("centeredDelta", () => {
  it("rests at 0x40 → 0, steps ±1 either side", () => {
    expect(centeredDelta(0x40)).toBe(0);
    expect(centeredDelta(0x41)).toBe(1);
    expect(centeredDelta(0x3f)).toBe(-1);
  });
  it("spans −64..+63 across the byte range", () => {
    expect(centeredDelta(0)).toBe(-64);
    expect(centeredDelta(127)).toBe(63);
  });
  it("is exactly val − 64 for every value", () => {
    for (const v of ALL) expect(centeredDelta(v)).toBe(v - 64);
  });
});

// Pioneer browse selector: 2's-complement relative, rests at 0, NOT centred on 0x40.
describe("twosComplementDelta", () => {
  it("rests at 0, forward 0x01..0x3F = +1..+63", () => {
    expect(twosComplementDelta(0)).toBe(0);
    expect(twosComplementDelta(0x01)).toBe(1);
    expect(twosComplementDelta(0x3f)).toBe(63);
  });
  it("back: 0x7F = −1, 0x41 = −63", () => {
    expect(twosComplementDelta(0x7f)).toBe(-1);
    expect(twosComplementDelta(0x41)).toBe(-63);
  });
  it("stays within −64..+63 (no full-range leaps)", () => {
    for (const v of ALL) {
      const d = twosComplementDelta(v);
      expect(d).toBeGreaterThanOrEqual(-64);
      expect(d).toBeLessThanOrEqual(63);
    }
  });
  it("is val for the low half, val−128 for the high half", () => {
    for (const v of ALL) expect(twosComplementDelta(v)).toBe(v < 64 ? v : v - 128);
  });
});

// THE bug this split guards: a browse "back one" arrives as 0x7F. Decoded as CENTERED it reads
// +63 (the cursor leaps 63 rows forward); decoded as 2's-complement it reads −1 (back one row).
describe("centered vs two's-complement are NOT interchangeable", () => {
  it("0x7F: centered → +63 (wrong for browse), two's-complement → −1 (correct)", () => {
    expect(centeredDelta(0x7f)).toBe(63);
    expect(twosComplementDelta(0x7f)).toBe(-1);
  });
  it("they only agree on the forward half below the midpoint", () => {
    // For 0..63 a centered decode is val−64 (negative) while two's-complement is val (positive):
    // the conventions diverge everywhere except where both happen to be 0 — i.e. never both nonzero-equal.
    const agree = ALL.filter((v) => centeredDelta(v) === twosComplementDelta(v));
    expect(agree).toEqual([]); // val−64 === val has no solution → they never coincide
  });
});

// Endless absolute encoder that wraps 127→0: fold (val−last) back into (−64, 64].
describe("wrappingStep", () => {
  it("first sample (no `last`) → 0, only seeds the reference", () => {
    expect(wrappingStep(undefined, 0)).toBe(0);
    expect(wrappingStep(undefined, 100)).toBe(0);
  });
  it("small steps either direction", () => {
    expect(wrappingStep(10, 11)).toBe(1);
    expect(wrappingStep(11, 10)).toBe(-1);
    expect(wrappingStep(64, 64)).toBe(0); // duplicate → no movement
  });
  it("reads a wrap as the small step it really is, not a ∓127 leap", () => {
    expect(wrappingStep(127, 0)).toBe(1); // wrapped up past the top
    expect(wrappingStep(0, 127)).toBe(-1); // wrapped down past the bottom
  });
  it("folds exactly at the ±64 boundary (>64 / <−64 are strict)", () => {
    expect(wrappingStep(0, 64)).toBe(64); // raw 64 is NOT folded
    expect(wrappingStep(0, 65)).toBe(-63); // raw 65 folds to −63
    expect(wrappingStep(64, 0)).toBe(-64); // raw −64 is NOT folded
    expect(wrappingStep(65, 0)).toBe(63); // raw −65 folds to +63
  });
  it("keeps a genuine mid-range jump intact (not every move is a wrap)", () => {
    expect(wrappingStep(10, 70)).toBe(60);
  });
  // The circular invariant over the FULL 128×128 matrix: applying the decoded step to `last`
  // lands back on `val` (mod 128), and the step is always within the half-circle (−64, 64].
  it("(last + step) ≡ val (mod 128) for every (last, val), step in (−64, 64]", () => {
    for (const last of ALL) {
      for (const val of ALL) {
        const step = wrappingStep(last, val);
        expect(((last + step) % 128 + 128) % 128).toBe(val);
        expect(step).toBeGreaterThan(-65);
        expect(step).toBeLessThanOrEqual(64);
      }
    }
  });
});
