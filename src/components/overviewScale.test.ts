import { describe, expect, it } from "vitest";
import { hitMarker, laneRect, labelsShareColumn, resolveLabels, type OverviewMarker } from "./overviewSeek";

// ★ operator, 2026-11-10: rail markers "super thin on mobile", hard to see and to hit. One scale
// (Settings ▸ Markers ▸ Overview markers) grows the mark, its label box and its tap radius together.
describe("overview marker scale", () => {
  const geom = { top: 0, height: 400, duration: 400, left: 0, width: 128, side: "left" as const };
  const cue: OverviewMarker[] = [{ t: 100, kind: "hot" }];
  it("widens the tap radius with the mark", () => {
    const x = laneRect("hot", "left", 128).x + 10; // in the cue lane
    expect(hitMarker(x, 110, geom, cue)).toBeNull(); // 10 px off, radius 7
    expect(hitMarker(x, 110, { ...geom, scale: 2 }, cue)).toBe(0); // radius 14
  });
  it("gives a bigger label a bigger box, so close labels yield", () => {
    const marks = [
      { y: 100, lane: "markers" as const, priority: 3, label: "1" },
      { y: 120, lane: "markers" as const, priority: 3, label: "2" },
    ];
    expect(resolveLabels(marks, false)).toEqual([true, true]); // 20 px apart, box 13
    expect(resolveLabels(marks, false, 2)).toEqual([true, false]); // box 26
  });
  it("a scaled label needs a wider lane before the labels share one column", () => {
    expect(labelsShareColumn(64)).toBe(false);
    expect(labelsShareColumn(64, 2)).toBe(true);
  });
});
