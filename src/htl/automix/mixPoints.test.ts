import { describe, test, expect } from "vitest";
import { blendBarsFor, chooseMixIn, chooseMixOut, dominantLabel, firstBodySection, type Sections } from "./mixPoints";

// A conventional 200 s arrangement, 8 sections of 25 s:
//   intro | verse | CHORUS | verse | CHORUS | bridge | CHORUS | outro
//   0       25      50       75      100      125      150      175
const song = (over: Partial<Sections> = {}): Sections => ({
  starts: [0, 25, 50, 75, 100, 125, 150, 175],
  labels: ["A", "B", "C", "B", "C", "D", "C", "E"],
  firstSound: 0,
  lastSound: 200,
  duration: 200,
  ...over,
});

describe("dominantLabel — finding the hook", () => {
  test("the most-repeated section is the chorus", () => {
    expect(dominantLabel(song())).toBe("C");
  });

  test("a section that never returns is not a hook", () => {
    expect(dominantLabel(song({ labels: ["A", "B", "C", "D", "E", "F", "G", "H"] }))).toBeNull();
  });

  test("ties go to whichever recurs latest — that is what the track ends up built around", () => {
    // B repeats at 1,3; C repeats at 2,4 — equal counts, C is later.
    const s = song({ labels: ["A", "B", "C", "B", "C", "D", "E", "F"] });
    expect(dominantLabel(s)).toBe("C");
  });

  test("no labels at all → null (unstructured track)", () => {
    expect(dominantLabel(song({ labels: [] }))).toBeNull();
    // A labels array that doesn't line up with the starts is corrupt — refuse to guess.
    expect(dominantLabel(song({ labels: ["A"] }))).toBeNull();
  });
});

describe("chooseMixOut — leaving on the last chorus", () => {
  test("exits at the END of the final chorus when the blend fits", () => {
    // Last "C" is at 150; it ends at 175 (the outro's start). A 20 s blend fits before 200.
    expect(chooseMixOut(song(), 20, 4)).toBe(175);
  });

  // The whole point of measuring from lastSound: never ride a blend into the dead tail.
  test("the blend must COMPLETE by the musical end", () => {
    const out = chooseMixOut(song(), 20, 4);
    expect(out + 20).toBeLessThanOrEqual(song().lastSound);
  });

  test("a blend too long for the final chorus falls back to a boundary that fits", () => {
    // 40 s blend: leaving at 175 would run to 215, past the 200 s musical end.
    const out = chooseMixOut(song(), 40, 4);
    expect(out).toBeLessThanOrEqual(160);
    expect(out + 40).toBeLessThanOrEqual(200);
    expect(song().starts).toContain(out); // still a real section boundary
  });

  test("an unstructured track falls back to the arithmetic target", () => {
    const s = song({ starts: [], labels: [] });
    expect(chooseMixOut(s, 20, 4)).toBeCloseTo(200 - 20 - 4, 6);
  });

  // A late lastSound with a huge blend must not produce a mix-out at 10% of the track.
  test("never exits so early that the track is effectively skipped", () => {
    const out = chooseMixOut(song(), 150, 4);
    expect(out).toBeGreaterThanOrEqual(song().duration * 0.35);
  });

  test("respects a trimmed musical end (a track with a long dead tail)", () => {
    const s = song({ lastSound: 160 });
    const out = chooseMixOut(s, 20, 4);
    expect(out + 20).toBeLessThanOrEqual(160);
  });
});

describe("firstBodySection — where the track actually starts", () => {
  test("skips a one-off intro and lands on the first recurring section", () => {
    expect(firstBodySection(song())).toBe(1); // "A" never returns; "B" does
  });

  test("a track whose first section already repeats starts there", () => {
    expect(firstBodySection(song({ labels: ["A", "B", "A", "B", "C", "C", "D", "E"] }))).toBe(0);
  });

  test("no repeats → null", () => {
    expect(firstBodySection(song({ labels: ["A", "B", "C", "D", "E", "F", "G", "H"] }))).toBeNull();
  });
});

describe("chooseMixIn — the incoming's intro rides under the outro", () => {
  test("cues back by the blend length so the body lands at the end of the blend", () => {
    // Body starts at 25; a 20 s blend means dropping the needle at 5.
    expect(chooseMixIn(song(), 20, 0)).toBe(5);
  });

  test("a body section closer than the blend is long just plays from the downbeat", () => {
    expect(chooseMixIn(song(), 40, 0)).toBe(0);
  });

  test("never cues before the first downbeat", () => {
    expect(chooseMixIn(song(), 20, 12)).toBeGreaterThanOrEqual(12);
  });

  test("a negligible intro starts at '1'", () => {
    const s = song({ starts: [0, 25], labels: ["A", "A"] }); // body IS the first section
    expect(chooseMixIn(s, 20, 0)).toBe(0);
  });

  test("no repeat structure → falls back to the first boundary past the content start", () => {
    const s = song({ labels: [], firstSound: 24 });
    expect(chooseMixIn(s, 10, 0)).toBe(15); // boundary at 25, minus a 10 s blend
  });
});

describe("blendBarsFor — a blend that fills its section, not one that straddles it", () => {
  // 120 bpm → 2 s per bar.
  test("caps the requested length at what the section can actually give", () => {
    // Mix-out at 175, section began at 150 → 25 s of material ≈ 12.5 bars.
    expect(blendBarsFor(song(), 175, 120, 32)).toBe(12);
  });

  test("never exceeds what the planner asked for", () => {
    expect(blendBarsFor(song(), 175, 120, 8)).toBeLessThanOrEqual(8);
  });

  test("is capped by the runway to the musical end, not just the section", () => {
    // Mix-out at 190 leaves only 10 s ≈ 5 bars before lastSound at 200.
    expect(blendBarsFor(song(), 190, 120, 32)).toBeLessThanOrEqual(4);
  });

  test("quantises to real phrase lengths", () => {
    expect([4, 8, 12, 16, 24, 32]).toContain(blendBarsFor(song(), 175, 120, 32));
  });

  test("falls back to the request when there is nothing to measure", () => {
    expect(blendBarsFor(song({ starts: [] }), 100, 120, 16)).toBe(16);
    expect(blendBarsFor(song(), 100, 0, 16)).toBe(16); // no bpm
  });
});
