import { describe, it, expect } from "vitest";
import { decodeGrid, encodeGrid, gridMatches } from "./gridWire";
import type { Beatgrid } from "../analysis/analyze";

// Operator, 2026-11-11: session sync audit — the anchor's grid rides the snapshot.
function grid(n: number): Beatgrid {
  const iv = 60 / 128;
  const beats = Float32Array.from({ length: n }, (_, i) => 0.137 + i * iv + (i % 3) * 0.0011);
  return { bpm: 128, firstBeat: 0.137, interval: iv, beats, downbeat: 1, beatsPerBar: 4, phrases: Float32Array.from([0.137, 30.1, 60.2]), phraseLabels: ["A", "B", "A"], phraseBars: 16, firstSound: 0.1, lastSound: 299 };
}

describe("gridWire", () => {
  it("round-trips within half a millisecond per beat", () => {
    const g = grid(640);
    const back = decodeGrid(JSON.parse(JSON.stringify(encodeGrid(g))))!;
    expect(back.bpm).toBe(128);
    expect(back.beats!.length).toBe(640);
    for (let i = 0; i < 640; i++) expect(Math.abs(back.beats![i] - g.beats![i])).toBeLessThan(0.0006);
    expect(back.phraseLabels).toEqual(["A", "B", "A"]);
    expect(back.downbeat).toBe(1);
  });
  it("is stable: an adopted grid matches the wire form that carried it (no endless re-adoption)", () => {
    const w = JSON.parse(JSON.stringify(encodeGrid(grid(640))));
    expect(gridMatches(decodeGrid(w), w)).toBe(true);
    const mine = grid(640);
    mine.beats = mine.beats!.map((b) => b + 0.003); // our own analysis, 3 ms off → adopt the anchor's
    expect(gridMatches(mine, w)).toBe(false);
    expect(gridMatches(grid(640), w)).toBe(true); // the same analysis → nothing to adopt
  });
  it("is compact: a 5-minute track's grid stays a few KB", () => {
    expect(JSON.stringify(encodeGrid(grid(640))).length).toBeLessThan(4000);
  });
  it("rejects malformed input instead of putting a bad grid on a deck", () => {
    expect(decodeGrid(null)).toBeNull();
    expect(decodeGrid({ bpm: 0, fb: 0, iv: 0.5 })).toBeNull();
    expect(decodeGrid({ bpm: 120, fb: "x", iv: 0.5 })).toBeNull();
    expect(encodeGrid(null)).toBeUndefined();
  });
});
