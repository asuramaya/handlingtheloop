import { describe, it, expect } from "vitest";
import { AudioEngine } from "./AudioEngine";

// The setting is a FEEL control on a measured trade, so the thing worth pinning is its bounds: a
// value outside the measured range is not a preference, it is a loop nobody has run.
describe("setSyncPhaseGain", () => {
  const gain = (e: AudioEngine) => (e as unknown as { syncPhaseK: number }).syncPhaseK;
  // A bare engine is enough: the clamp is pure and the constructor's audio graph is not under test.
  const eng = () => Object.create(AudioEngine.prototype) as AudioEngine;

  it("takes a value inside the measured range", () => {
    const e = eng();
    e.setSyncPhaseGain(0.18); // the "tight" end, seek settles 0.005 beats at 4.19% peak trim
    expect(gain(e)).toBeCloseTo(0.18, 6);
  });

  it("refuses to go slower than the gentleness already reported as too slow", () => {
    const e = eng();
    e.setSyncPhaseGain(0.001);
    expect(gain(e)).toBeCloseTo(0.02, 6);
  });

  it("refuses a gain whose rate trim would be a plainly audible pitch move", () => {
    const e = eng();
    e.setSyncPhaseGain(5);
    expect(gain(e)).toBeCloseTo(0.3, 6);
  });

  // The control: a broken setting must fall back to the SHIPPED behaviour, not to zero. A gain of 0
  // is a sync that never corrects, which looks like the defect this whole investigation is about.
  it("falls back to the shipped default on a non-finite value, never to zero", () => {
    const e = eng();
    e.setSyncPhaseGain(NaN);
    expect(gain(e)).toBeCloseTo(0.06, 6);
    e.setSyncPhaseGain(Infinity);
    expect(gain(e)).toBeCloseTo(0.06, 6);
  });
});
