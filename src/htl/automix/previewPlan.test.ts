import { describe, expect, test } from "vitest";
import { previewPlan, transitionLabel } from "./mixability";
import type { TrackMeta } from "../library/types";

const t = (bpm: number, key: string): TrackMeta => ({ videoId: `v${bpm}${key}`, title: "x", artist: "y", duration: 200, thumbnail: null, views: null, bpm, key });

// The queue's Mix badge has to promise what the mixer will do (operator's queue, 2026-11-04:
// T.I. 99 BPM → Keri Hilson 160 BPM was badged "Cut").
describe("previewPlan", () => {
  test("99 → 160 BPM (the queue's Keri Hilson row): 160 folds to 80, 24 % apart → bridged, not 'Cut'", () => {
    const p = previewPlan(t(99, "7B"), t(160, "11B"));
    expect(transitionLabel(p.plan)).toBe("Bridge");
    expect(p.why).toMatch(/99 → 160 BPM \(24% apart\)/);
  });

  test("88 → 130 BPM: too far even to bridge → an echo out", () => {
    const p = previewPlan(t(88, "8A"), t(130, "8A"));
    expect(transitionLabel(p.plan)).toBe("Echo 4");
    expect(p.why).toMatch(/echo/);
  });

  test("124 → 145 BPM: bridged on a loop", () => {
    const p = previewPlan(t(124, "8A"), t(145, "8A"));
    expect(transitionLabel(p.plan)).toBe("Bridge");
    expect(p.why).toMatch(/loop/);
  });

  test("a matchable pair keeps the planner's blend, banded by tempo", () => {
    const house = previewPlan(t(124, "8A"), t(126, "8A"));
    expect(house.plan.style).toBe("blend");
    expect(house.plan.bars).toBe(32);
    const rnb = previewPlan(t(92, "8A"), t(94, "8A"));
    expect(rnb.plan.bars).toBe(8); // under 100 BPM: short, the way those DJs mix
  });
});
