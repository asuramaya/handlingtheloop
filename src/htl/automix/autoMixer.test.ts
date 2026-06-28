import { describe, test, expect } from "vitest";
// autoMixer.ts imports cleanly in a plain-node test env (no AudioContext/DOM is
// touched at module load — the engine is only reached through the injected deps),
// so its pure module-level helpers can be unit-tested directly.
import { barsToSeconds, other } from "./autoMixer";

describe("barsToSeconds", () => {
  // 4 bars * 4 beats/bar * 60s / bpm. At 120bpm: 16 beats * 0.5s = 8s.
  test("4 bars @ 120bpm = 8s", () => {
    expect(barsToSeconds(4, 120)).toBeCloseTo(8, 10);
  });

  test("12 bars @ 120bpm = 24s (the armed-phase default lead window)", () => {
    expect(barsToSeconds(12, 120)).toBeCloseTo(24, 10);
  });

  test("1 bar @ 60bpm = 4s (one beat per second, 4 beats)", () => {
    expect(barsToSeconds(1, 60)).toBeCloseTo(4, 10);
  });

  test("scales inversely with bpm: doubling bpm halves the seconds", () => {
    expect(barsToSeconds(8, 174)).toBeCloseTo(barsToSeconds(8, 87) / 2, 10);
  });

  // Invalid/zero/negative bpm → fallback of `bars * 2` seconds (a neutral 120bpm-ish
  // guess so the mixer never divides by zero or produces NaN/Infinity).
  test("bpm = 0 → fallback bars*2", () => {
    expect(barsToSeconds(4, 0)).toBe(8);
  });

  test("negative bpm → fallback bars*2", () => {
    expect(barsToSeconds(6, -120)).toBe(12);
  });

  test("NaN bpm → fallback bars*2 (NaN is falsy under the `!bpm` guard? no — guard uses bpm<=0)", () => {
    // NOTE: the guard is `if (!bpm || bpm <= 0)`. NaN is truthy-falsy: `!NaN === true`,
    // so NaN hits the fallback branch and returns bars*2. Documented, not a bug.
    expect(barsToSeconds(3, NaN)).toBe(6);
  });
});

describe("other", () => {
  test("A → B", () => {
    expect(other("A")).toBe("B");
  });

  test("B → A", () => {
    expect(other("B")).toBe("A");
  });

  test("is an involution: other(other(x)) === x", () => {
    expect(other(other("A"))).toBe("A");
    expect(other(other("B"))).toBe("B");
  });
});
