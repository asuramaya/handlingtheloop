import { describe, expect, test } from "vitest";
import { nearestDownbeat } from "./analyze";
import type { Beatgrid } from "./analyze";

// 120 BPM, beats every 0.5 s from 0.25, downbeat on beat index 1 (t = 0.75) → bars at 0.75, 2.75, 4.75 …
const beats = Float32Array.from({ length: 200 }, (_, i) => 0.25 + i * 0.5);
const g = { bpm: 120, firstBeat: 0.25, interval: 0.5, beats, downbeat: 1, beatsPerBar: 4 } as unknown as Beatgrid;

describe("nearestDownbeat", () => {
  test("snaps to the nearest BAR line, not the nearest beat", () => {
    expect(nearestDownbeat(g, 3.25)).toBeCloseTo(2.75, 5); // beat 2 of the bar → back to its 1
    expect(nearestDownbeat(g, 4.25)).toBeCloseTo(4.75, 5); // beat 4 → forward to the next 1
  });
  test("with a floor, never lands behind it", () => {
    expect(nearestDownbeat(g, 3.25, 3.0)).toBeCloseTo(4.75, 5);
    expect(nearestDownbeat(g, 2.8, 2.7)).toBeCloseTo(2.75, 5);
  });
});
