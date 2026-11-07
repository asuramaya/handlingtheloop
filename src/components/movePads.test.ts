import { describe, expect, it, vi } from "vitest";
import { MOVE_PADS } from "./movePads";
import { fireFxPadArg, padsForDeck } from "./fxPads";
import type { Deck } from "@htl/audio";

// FX2 = the moves bank (operator, 2026-11-06). Held moves must hand back exactly what they took.
function fakeDeck(padMode = "fx2") {
  return {
    padMode,
    eqLow: 3,
    filterValue: -0.2,
    beatgrid: { interval: 0.5 },
    rate: 1,
    setEqLow(v: number) { this.eqLow = v; },
    setFilter(v: number) { this.filterValue = v; },
  };
}
const pad = (label: string) => MOVE_PADS.find((p) => p.label === label)!;

describe("FX2 moves", () => {
  it("FX2's eight pads are the moves, in the agreed order", () => {
    expect(padsForDeck(fakeDeck() as unknown as Deck).map((p) => p?.label)).toEqual(["SPIN", "CENSOR", "BRAKE", "ECHO OUT", "FILTER OUT", "BASS CUT", "STUTTER", "WASH"]);
  });

  it("BASS CUT kills the low EQ while held and restores YOUR setting on release", () => {
    const d = fakeDeck();
    const p = pad("BASS CUT");
    p.on(d as unknown as Deck);
    expect(d.eqLow).toBe(-40);
    expect(p.active!(d as unknown as Deck)).toBe(true);
    p.off!(d as unknown as Deck);
    expect(d.eqLow).toBe(3);
    expect(p.active!(d as unknown as Deck)).toBe(false);
  });

  it("FILTER OUT sweeps up, and release snaps the filter back to where you had it", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "performance"] });
    try {
      const d = fakeDeck();
      const p = pad("FILTER OUT");
      p.on(d as unknown as Deck);
      vi.advanceTimersByTime(2000); // halfway through 8 beats at 120 bpm, eased in
      const mid = d.filterValue;
      expect(mid).toBeGreaterThan(-0.2);
      vi.advanceTimersByTime(2200); // the whole 2 bars
      expect(d.filterValue).toBeCloseTo(0.9, 5);
      expect(mid).toBeLessThan(d.filterValue);
      p.off!(d as unknown as Deck);
      expect(d.filterValue).toBe(-0.2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a received move fires on the receiver even when it sits in another bank", () => {
    const d = fakeDeck("cue");
    fireFxPadArg(d as unknown as Deck, "@moves:5", true); // BASS CUT
    expect(d.eqLow).toBe(-40);
    fireFxPadArg(d as unknown as Deck, "@moves:5", false);
    expect(d.eqLow).toBe(3);
  });
});
