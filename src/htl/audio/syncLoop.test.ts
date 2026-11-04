import { describe, expect, it } from "vitest";
import { Deck } from "./Deck";
import { simulateSyncRecovery, SYNC_PHASE_K, SYNC_TRIM_MAX } from "./syncLoop";

describe("the SYNC phase-lock loop, as Settings ▸ Sync pull draws it", () => {
  it("uses the deck's own trim clamp", () => {
    expect(SYNC_TRIM_MAX).toBe(Deck.SYNC_TRIM_MAX);
  });

  it("gentle is slow and quiet, tight is fast and costs a bigger bend (the trade the setting is)", () => {
    const gentle = simulateSyncRecovery(SYNC_PHASE_K);
    const tight = simulateSyncRecovery(0.18);
    expect(gentle.settleS).toBeGreaterThan(tight.settleS * 1.5); // measured 11.3 s vs 5.8 s
    expect(tight.peakTrim).toBeGreaterThan(gentle.peakTrim * 2);
    expect(tight.peakTrim).toBeLessThanOrEqual(SYNC_TRIM_MAX);
  });

  it("pulls the error toward zero without flipping sign (no overshoot past the beat)", () => {
    for (const k of [0.02, 0.06, 0.12, 0.3]) {
      const r = simulateSyncRecovery(k);
      expect(Math.abs(r.err[r.err.length - 1])).toBeLessThan(0.25);
      expect(Math.min(...r.err)).toBeGreaterThan(-0.02);
    }
  });
});
