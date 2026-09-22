import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { type Beatgrid, nextBeat } from "./analyze";

// A Beatgrid CARRIES TWO DESCRIPTIONS OF WHERE THE BEATS ARE, AND THEY DISAGREE.
//
// `beats[]` is what the tracker found. `firstBeat` + k·`interval` is a best-fit line through it.
// The header of the beat-query section says sync, snapping and the renderer all go through the
// helpers so the two behave identically — which is a claim about its own siblings, and the whole
// point of the helpers is that the two do NOT behave identically. Any call site doing the comb
// arithmetic itself is answering a different question from every call site that does not.
//
// GamepadEngine was one: it computed its beat-rumble clock as `firstBeat + k·interval` and counted
// bars from index 0 rather than from `downbeat`. So the pulse landed off the beat, and the heavier
// downbeat pulse fell on whichever beat of the bar the grid happened to start on.
//
// The last test is the one that matters: it reads REAL grids this build's own detector produced and
// asserts the two descriptions genuinely diverge on them. If someone ever "simplifies" nextBeat back
// to the comb, that test fails on real material rather than on a constructed example.

/** A grid whose tracked beats sit a known distance off its own uniform comb — which is what a
 *  best-fit line through slightly uneven beats always produces. */
function grid(over: Partial<Beatgrid> = {}): Beatgrid {
  const beats = Float32Array.from([0.5, 1.02, 1.48, 2.04, 2.49, 3.01, 3.5, 4.03]);
  return { bpm: 120, firstBeat: 0.75, interval: 0.5, beats, beatsPerBar: 4, downbeat: 1, ...over };
}

describe("nextBeat", () => {
  it("answers from the tracked beats, not from the comb", () => {
    // The comb would say 2.25; the tracker says 2.49. A quarter of a beat apart, on a grid this
    // ordinary.
    expect(nextBeat(grid(), 2.1).time).toBeCloseTo(2.49, 5);
    expect(grid().firstBeat + Math.ceil((2.1 - 0.75) / 0.5) * 0.5).toBeCloseTo(2.25, 5);
  });

  it("returns t's own beat when t sits exactly on one — not the following beat", () => {
    // Off by one here would fire every pulse a beat early forever.
    const g = grid();
    expect(nextBeat(g, 1.48).time).toBeCloseTo(1.48, 5);
    expect(nextBeat(g, 1.48).index).toBe(2);
  });

  it("counts bars from `downbeat`, so 'the one' is the music's, not the array's", () => {
    const g = grid({ downbeat: 1 }); // beats[1] starts a bar → indices 1, 5, 9…
    expect(nextBeat(g, 1.02).downbeat).toBe(true);
    expect(nextBeat(g, 0.5).downbeat).toBe(false); // index 0 is NOT the one here
    expect(nextBeat(g, 2.49).downbeat).toBe(false);
    expect(nextBeat(g, 3.01).downbeat).toBe(true); // index 5
  });

  it("extrapolates past the tracked range instead of stalling on the last beat", () => {
    const g = grid();
    const past = nextBeat(g, 5.0);
    expect(past.time).toBeGreaterThan(5.0);
    expect(past.index).toBeGreaterThan(7);
  });

  it("falls back to the comb only when there are no tracked beats", () => {
    const g = grid({ beats: undefined, downbeat: undefined });
    expect(nextBeat(g, 2.1).time).toBeCloseTo(2.25, 5);
    expect(nextBeat(g, 2.1).index).toBe(3);
  });

  it("the two descriptions really do diverge on real analysed material", () => {
    const fixture = JSON.parse(readFileSync(resolve(process.cwd(), "scripts/synclab/real-grids.json"), "utf8")) as {
      grids: { videoId: string; bpm: number; firstBeat: number; interval: number; beats: number[] }[];
    };
    expect(fixture.grids.length).toBeGreaterThan(0);
    const worst = fixture.grids.map((r) => {
      const g: Beatgrid = { bpm: r.bpm, firstBeat: r.firstBeat, interval: r.interval, beats: Float32Array.from(r.beats) };
      let max = 0;
      for (let k = 0; k < 200; k++) {
        const t = r.beats[0] + (k / 200) * (r.beats[r.beats.length - 1] - r.beats[0]);
        const comb = r.firstBeat + Math.ceil((t - r.firstBeat) / r.interval) * r.interval;
        const e = Math.abs(comb - nextBeat(g, t).time) / r.interval;
        max = Math.max(max, Math.min(e, Math.abs(1 - e)));
      }
      return max;
    });
    // Not every grid diverges — the steadiest in the pool stays inside 0.05 beats, which is worth
    // knowing: this is a property of the MATERIAL, not something every track suffers. What the fix
    // rests on is that real tracks reach half a beat, and they do.
    expect(Math.max(...worst)).toBeGreaterThan(0.25);
    expect(Math.min(...worst)).toBeGreaterThan(0.01);
  });
});
