import { describe, expect, it } from "vitest";
import { cyclePhase, quantizeStep } from "./quantize";
import type { Beatgrid } from "../analysis/analyze";

// A 120 bpm grid (0.5 s beats) with its first downbeat on beat 0 at t = 1.0.
const grid = (first = 1, downbeat = 0): Beatgrid => {
  const beats = new Float32Array(400).map((_, i) => first + i * 0.5);
  return { bpm: 120, firstBeat: first, interval: 0.5, beats, downbeat, beatsPerBar: 4 } as Beatgrid;
};

describe("cyclePhase — beats into a grid-size cycle, from the downbeat", () => {
  it("counts beats in the bar from the downbeat, sub-beat units fold the beat", () => {
    const g = grid(1, 1); // the "1" is beat index 1 (t = 1.5)
    expect(cyclePhase(g, 1.5, 4)).toBeCloseTo(0, 6); // on the 1
    expect(cyclePhase(g, 2.75, 4)).toBeCloseTo(2.5, 6); // beat 3, halfway
    expect(cyclePhase(g, 1.0, 4)).toBeCloseTo(3, 6); // beat 0 is the 4 of the bar before
    expect(cyclePhase(g, 1.125, 0.5)).toBeCloseTo(0.25, 6);
  });
});

describe("quantizeStep — when and where a quantized jump lands", () => {
  const g = grid();
  it("waits for the reference's next bar line when the target is a downbeat (unit 1 bar)", () => {
    // reference is on beat 2 of its bar (t = 2.0 is beat 2 from t = 1.0); target a bar start (t = 9)
    const r = quantizeStep(g, 9, { grid: g, pos: 2.0, rate: 1 }, 4);
    expect(r.waitSec).toBeCloseTo(1.0, 6); // 2 beats to go at 0.5 s
    expect(r.pos).toBe(9);
  });
  it("a faster reference shortens the wait in wall time", () => {
    expect(quantizeStep(g, 9, { grid: g, pos: 2.0, rate: 2 }, 4).waitSec).toBeCloseTo(0.5, 6);
  });
  it("a press a touch after the boundary fires at once, landing as far in as the reference is", () => {
    const r = quantizeStep(g, 9, { grid: g, pos: 3.03, rate: 1 }, 4); // 0.06 beats past the 1
    expect(r.waitSec).toBe(0);
    expect(r.pos).toBeCloseTo(9.03, 6);
  });
  it("too late misses the bar and waits for the next one", () => {
    const r = quantizeStep(g, 9, { grid: g, pos: 3.2, rate: 1 }, 4); // 0.4 beats past
    expect(r.waitSec).toBeCloseTo(3.6 * 0.5, 6);
  });
  it("after a timer fired, slack short of half a unit is taken as late, not as a miss", () => {
    const r = quantizeStep(g, 9, { grid: g, pos: 3.2, rate: 1 }, 4, true);
    expect(r.waitSec).toBe(0);
    expect(r.pos).toBeCloseTo(9.2, 6);
  });
  it("a target mid-beat lines up with the same point in the reference's beat (unit 1 beat)", () => {
    const r = quantizeStep(g, 9.25, { grid: g, pos: 2.0, rate: 1 }, 1);
    expect(r.waitSec).toBeCloseTo(0.25, 6);
  });
});
