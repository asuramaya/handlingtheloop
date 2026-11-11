// Follow-rate continuity (operator, 2026-11-11: session sync audit): Deck.followTick re-anchors before
// adopting a new rate, and compares to the rate last PUSHED, not the previous tick.
import { describe, expect, it } from "vitest";
import { clockPos, nextFollowRate, setClockRate, FOLLOW_RATE_EPS, type RateClock } from "./followClock";

describe("follow rate continuity", () => {
  it("re-anchoring before a rate change keeps the playhead continuous", () => {
    const c: RateClock = { startOffset: 0, startedAt: 0, rate: 1 };
    const before = clockPos(c, 60); // a minute in
    const after = setClockRate(c, 1.02, 60);
    expect(clockPos(after, 60)).toBeCloseTo(before, 9);
    // the bug: swapping the rate un-anchored rescales the whole minute → a 1.2 s jump
    expect(clockPos({ ...c, rate: 1.02 }, 60) - before).toBeCloseTo(1.2, 9);
  });
  it("a slow ramp below the per-tick threshold still reaches the audio: compared to the PUSHED rate", () => {
    let pushed: number | null = 1;
    let pushes = 0;
    for (let i = 1; i <= 10; i++) {
      const tick = 1 + i * (FOLLOW_RATE_EPS / 2); // each tick moves by half the threshold
      const next = nextFollowRate(pushed, tick);
      if (next != null) {
        pushed = next;
        pushes++;
      }
    }
    expect(pushes).toBeGreaterThan(0);
    expect(Math.abs((pushed ?? 0) - (1 + 10 * (FOLLOW_RATE_EPS / 2)))).toBeLessThanOrEqual(FOLLOW_RATE_EPS);
  });
  it("adopts the first rate, ignores absent / nonsense rates and sub-threshold jitter", () => {
    expect(nextFollowRate(null, 1.01)).toBe(1.01);
    expect(nextFollowRate(1, undefined)).toBeNull();
    expect(nextFollowRate(1, 0)).toBeNull();
    expect(nextFollowRate(1, 1 + FOLLOW_RATE_EPS / 2)).toBeNull();
  });
});
