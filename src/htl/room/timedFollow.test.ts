import { describe, expect, it } from "vitest";
import { decideTimedFollow, TIMED_TRIM_MAX } from "./sessionFollow";

const base = { masterPlaying: true, deckPlaying: true, masterNow: 60, deckPos: 60.05, deckLatency: 0.05, sinceFollowSeekMs: 5000 };

describe("decideTimedFollow — a follower with a shared clock and its own latency", () => {
  it("on time: our engine runs exactly our latency ahead of what the host is heard playing", () => {
    expect(decideTimedFollow(base)).toEqual({ kind: "trim", trim: 0 });
  });
  it("a small LEAD slows us down, a small LAG speeds us up — both directions, no seek", () => {
    const ahead = decideTimedFollow({ ...base, deckPos: 60.07 }); // 20 ms ahead
    const behind = decideTimedFollow({ ...base, deckPos: 60.03 }); // 20 ms behind
    expect(ahead.kind).toBe("trim");
    expect(behind.kind).toBe("trim");
    if (ahead.kind === "trim" && behind.kind === "trim") {
      expect(ahead.trim).toBeCloseTo(-0.006, 6);
      expect(behind.trim).toBeCloseTo(0.006, 6);
    }
  });
  it("the trim acts on the SMOOTHED error: clock-read jitter inside the band does nothing", () => {
    expect(decideTimedFollow({ ...base, deckPos: 60.055, smoothErr: 0.002 })).toEqual({ kind: "trim", trim: 0 });
  });
  it("the trim is capped", () => {
    const r = decideTimedFollow({ ...base, deckPos: 60.15 });
    expect(r).toEqual({ kind: "trim", trim: -TIMED_TRIM_MAX });
  });
  it("a large error seeks, ahead as well as behind, once per grace window", () => {
    expect(decideTimedFollow({ ...base, deckPos: 60.5 })).toEqual({ kind: "seek", target: 60.05 });
    expect(decideTimedFollow({ ...base, deckPos: 59.5 })).toEqual({ kind: "seek", target: 60.05 });
    expect(decideTimedFollow({ ...base, deckPos: 59.5, sinceFollowSeekMs: 300 })).toEqual({ kind: "hold" });
  });
  it("a start lands latency-compensated; a stop lands on the host's paused spot", () => {
    expect(decideTimedFollow({ ...base, deckPlaying: false, deckPos: 10 })).toEqual({ kind: "start", target: 60.05 });
    expect(decideTimedFollow({ ...base, masterPlaying: false })).toEqual({ kind: "stop", target: 60 });
  });
});
