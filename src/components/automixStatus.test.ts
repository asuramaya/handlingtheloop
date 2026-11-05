import { describe, expect, it } from "vitest";
import { IDLE_AUTOMIX_STATUS, type AutoMixStatus } from "@htl/automix";
import { autoLine, fmtClock } from "./automixStatus";

const on = (p: Partial<AutoMixStatus>): AutoMixStatus => ({ ...IDLE_AUTOMIX_STATUS, enabled: true, ...p });

describe("autoLine: what AUTO is doing, in words", () => {
  it("off", () => {
    const l = autoLine(IDLE_AUTOMIX_STATUS, "Next");
    expect(l.tone).toBe("idle");
    expect(l.chip).toBeNull();
  });
  it("counting down to the next mix names the track and the time", () => {
    const l = autoLine(on({ phase: "armed", countdownSec: 42.2, planLabel: "Blend 16", planResolved: false }), "Into You");
    expect(l.headline).toBe("Mixes into “Into You” in 43s");
    expect(l.chip).toBe("43s");
    expect(l.detail).toBe("planned: Blend 16");
  });
  it("mixing shows progress (the old label could never appear)", () => {
    const l = autoLine(on({ phase: "mixing", mixProgress: 0.45, countdownSec: 8 }), "X");
    expect(l.chip).toBe("45%");
    expect(l.tone).toBe("mix");
  });
  it("held, manual, and every wait reason say something different", () => {
    const seen = new Set<string>();
    for (const s of [
      on({ held: true }),
      on({ manual: true }),
      ...(["press-play", "queue-empty", "radio-filling", "loading-next", "stems", "playlist-ended"] as const).map((w) => on({ waitReason: w })),
    ])
      seen.add(autoLine(s, "T").headline);
    expect(seen.size).toBe(8);
  });
  it("Mix now reads as now", () => {
    expect(autoLine(on({ phase: "preload", countdownSec: 30, forced: true }), "T").chip).toBe("now");
  });
  it("fmtClock", () => {
    expect(fmtClock(5.1)).toBe("6s");
    expect(fmtClock(75)).toBe("1:15");
    expect(fmtClock(-3)).toBe("0s");
  });
});
