import { describe, expect, it } from "vitest";
import { applyIntent, carried } from "./applyIntent";
import { Session } from "./roomSim";

// A landed position (seek, play-from, hot-cue jump, loop snap-back) reaches the receiver one network
// delay after the sender did it; a playing receiver must land where the sender is NOW.
describe("carried (session sync audit: intents stamped with the room clock)", () => {
  it("carries a playing position forward by the transit time at the deck's rate", () => {
    expect(carried(10, 0.075, 1, null)).toBeCloseTo(10.075, 6);
    expect(carried(10, 0.1, 1.02, null)).toBeCloseTo(10.102, 6);
  });
  it("does nothing without a transit time", () => {
    expect(carried(10, 0, 1, null)).toBe(10);
    expect(carried(10, -0.2, 1, null)).toBe(10);
  });
  it("folds back inside an active loop the position sits in", () => {
    // 0.5 s loop from 20; landed at 20.45, 0.1 s later the sender is 0.05 s past the wrap
    expect(carried(20.45, 0.1, 1, { active: true, start: 20, end: 20.5 })).toBeCloseTo(20.05, 6);
  });
  it("does not fold a position outside the loop or an inactive loop", () => {
    expect(carried(30, 0.1, 1, { active: true, start: 20, end: 20.5 })).toBeCloseTo(30.1, 6);
    expect(carried(20.45, 0.1, 1, { active: false, start: 20, end: 20.5 })).toBeCloseTo(20.55, 6);
  });
});

describe("applyIntent with a transit time", () => {
  it("a seek on a playing receiver lands where the sender is now; a paused one lands exactly", () => {
    const s = new Session("host", "guest");
    const g = s.devices[1];
    const deck = g.engine.deck("A");
    deck.play();
    applyIntent({ kind: "transport", deck: "A", action: "seek", position: 50 }, g.engine, g.host, { late: 0.08 });
    expect(deck.position()).toBeCloseTo(50.08, 3);
    deck.pause();
    applyIntent({ kind: "transport", deck: "A", action: "seek", position: 60 }, g.engine, g.host, { late: 0.08 });
    expect(deck.position()).toBeCloseTo(60, 6);
  });
});
