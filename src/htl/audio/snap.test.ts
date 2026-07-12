import { describe, it, expect } from "vitest";
import { snapIndex } from "./snap";

// The delay's note grid, in beats.
const DIVS = [0.25, 1 / 3, 0.5, 0.75, 1, 1.5, 2, 3, 4];

describe("snapIndex — the lock", () => {
  it("takes the nearest rung when it has no opinion", () => {
    expect(snapIndex(0.5, DIVS, -1)).toBe(2); // exactly 1/8
    expect(snapIndex(0.98, DIVS, -1)).toBe(4); // ~1/4
    expect(snapIndex(3.9, DIVS, -1)).toBe(8); // ~1 bar
  });

  it("holds its rung against small jitter — the whole point", () => {
    // Sitting ON 1/8 (0.5) with a hand that wobbles a few percent either way.
    for (const v of [0.48, 0.49, 0.5, 0.51, 0.52, 0.53]) {
      expect(snapIndex(v, DIVS, 2)).toBe(2);
    }
  });

  it("★ does not flicker at the boundary — the bug this exists to kill", () => {
    // The midpoint between 1/8 (0.5) and 3/16 (0.75), in LOG space, is sqrt(0.5*0.75) ≈ 0.612.
    const mid = Math.sqrt(0.5 * 0.75);
    // A bare "nearest" would flip on either side of this. The lock holds whichever rung it's on.
    expect(snapIndex(mid - 0.001, DIVS, 2)).toBe(2);
    expect(snapIndex(mid + 0.001, DIVS, 2)).toBe(2); // still held, even PAST the midpoint
    expect(snapIndex(mid - 0.001, DIVS, 3)).toBe(3); // and held the other way too
    expect(snapIndex(mid + 0.001, DIVS, 3)).toBe(3);
  });

  it("releases decisively once you commit to the next rung", () => {
    // Far enough past the midpoint, the lock lets go — and it JUMPS, it doesn't ease.
    expect(snapIndex(0.74, DIVS, 2)).toBe(3); // 1/8 → 3/16
    expect(snapIndex(0.51, DIVS, 3)).toBe(2); // 3/16 → 1/8, coming back
  });

  it("is symmetric — the deadband is the same going up and coming back", () => {
    // Walk up from 1/8 until it releases, then walk back down until it releases again. The two
    // release points must straddle the midpoint evenly, or the control drifts one way.
    let up = 0.5;
    while (snapIndex(up, DIVS, 2) === 2 && up < 0.75) up += 0.001;
    let down = 0.75;
    while (snapIndex(down, DIVS, 3) === 3 && down > 0.5) down -= 0.001;
    const mid = Math.sqrt(0.5 * 0.75);
    expect(Math.abs(Math.log(up / mid) + Math.log(down / mid))).toBeLessThan(0.02);
  });

  it("measures in LOG space, because musical ladders are ratios", () => {
    // Linearly, 3 beats is much closer to 4 than to 2 (distance 1 vs 1). Musically it's dead
    // centre — 3/4 IS a rung, and either neighbour is a fair hop. Take a value a hair above 3:
    // log-nearest keeps it on 3, a LINEAR nearest would already be sliding toward 4.
    expect(snapIndex(3.05, DIVS, -1)).toBe(7); // the 3-beat rung, not the 4-beat one
    // And down at the short end, where the rungs are tightly packed in absolute terms, the same
    // fractional wobble must NOT skip a rung.
    expect(snapIndex(0.26, DIVS, -1)).toBe(0);
  });

  it("stick=0 reproduces the flicker (a regression guard on the guard)", () => {
    const mid = Math.sqrt(0.5 * 0.75);
    expect(snapIndex(mid + 0.001, DIVS, 2, 0)).toBe(3); // flips immediately past the midpoint
    expect(snapIndex(mid - 0.001, DIVS, 3, 0)).toBe(2); // …and flips straight back
  });

  it("survives a rubbish `current` and an empty ladder", () => {
    expect(snapIndex(0.5, DIVS, 99)).toBe(2); // out of range → take nearest
    expect(snapIndex(0.5, DIVS, -7)).toBe(2);
    expect(snapIndex(0.5, [], 0)).toBe(-1);
    expect(snapIndex(0, DIVS, -1)).toBe(0); // a zero value can't blow up the log
  });

  it("works on the wobble's ladder too — the same lock, different rungs", () => {
    const LFO = [0.25, 0.5, 1, 2, 4, 8, 16]; // beats per LFO cycle
    expect(snapIndex(4.2, LFO, -1)).toBe(4); // 1 bar
    expect(snapIndex(5.4, LFO, 4)).toBe(4); // held — a big absolute wobble, still musically near
    expect(snapIndex(7.6, LFO, 4)).toBe(5); // committed to 2 bars
  });
});
