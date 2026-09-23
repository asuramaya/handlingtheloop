import { describe, expect, it } from "vitest";
import { grMeterFraction } from "./MasterBand";

// The master GR meter was already built and already rAF-driven. What made it useless for the
// operator's own report was its RANGE: the cross-deck punch is 1.88 dB (hot mix) against 0.00 dB at
// mid mix, and 1.88 linear on a 12 dB full scale is 16% of a band a few pixels tall. The meter was
// correct and could not show the defect it was pointed at.
//
// These pin the mapping rather than the appearance. "Looks better" is not a measurement.

describe("master gain-reduction meter mapping", () => {
  it("is silent at zero — no limiting must read as nothing at all", () => {
    expect(grMeterFraction(0)).toBe(0);
  });

  it("puts the MEASURED punch (1.88 dB) where a few pixels can show it", () => {
    const f = grMeterFraction(1.88);
    expect(f).toBeGreaterThan(0.3); // linear gave 0.157 — under a third of this
    expect(f).toBeLessThan(0.5); // and it must not read as heavy limiting either
  });

  it("still reaches full scale at 12 dB, so heavy limiting has somewhere to go", () => {
    expect(grMeterFraction(12)).toBeCloseTo(1, 6);
  });

  it("is monotonic — a meter that can fall as the signal rises is worse than none", () => {
    let prev = -1;
    for (let db = 0; db <= 14; db += 0.25) {
      const f = grMeterFraction(db);
      expect(f).toBeGreaterThanOrEqual(prev);
      prev = f;
    }
  });

  it("clamps above full scale instead of overflowing the band", () => {
    expect(grMeterFraction(40)).toBe(1);
  });

  it("CONTROL: it is NOT the linear map — otherwise this change did nothing", () => {
    expect(grMeterFraction(1.88)).not.toBeCloseTo(1.88 / 12, 3);
  });
});
