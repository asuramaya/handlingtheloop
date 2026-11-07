import { describe, expect, test } from "vitest";
import { BRIDGE, bridgeShape } from "./autoMixer";
import { resolveStyle } from "./mixability";
import type { StyleCapabilities, TransitionPlan } from "./types";

// THE TEMPO BRIDGE, walked bar by bar as plain numbers (bridgeShape is pure).
describe("bridgeShape", () => {
  const at = (b: number, showy = true) => bridgeShape(b, showy);

  test("the looped bar rides to the new tempo over the first four bars, smoothly", () => {
    expect(at(0).tempoT).toBe(0);
    expect(at(2).tempoT).toBeCloseTo(0.5, 6);
    expect(at(BRIDGE.rampEnd).tempoT).toBe(1);
    let prev = -1;
    for (let b = 0; b <= 4; b += 0.1) {
      expect(at(b).tempoT).toBeGreaterThanOrEqual(prev);
      prev = at(b).tempoT;
    }
  });

  test("nothing of the new track before the drop; on it, nearly all of it", () => {
    for (let b = 0; b < BRIDGE.drop; b += 0.25) expect(at(b).fader).toBe(0);
    expect(at(BRIDGE.drop).dropped).toBe(true);
    expect(at(BRIDGE.drop).fader).toBeGreaterThanOrEqual(0.8);
    expect(at(BRIDGE.bars).fader).toBeCloseTo(1, 6);
  });

  test("the build: the loop halves on its bar lines, the bass is pulled, the filter climbs", () => {
    expect(at(3.9).rollBeats).toBe(0);
    expect(at(4).rollBeats).toBe(2);
    expect(at(5).rollBeats).toBe(1);
    expect(at(5.5).rollBeats).toBe(0.5);
    expect(at(4).eqLow).toBeCloseTo(0, 6);
    expect(at(5.99).eqLow).toBeLessThan(-20);
    expect(at(5.9).filter).toBeGreaterThan(at(4).filter);
  });

  test("the breath: the last beat before the drop is the frozen echo alone", () => {
    expect(at(5.7).freeze).toBe(false);
    expect(at(5.75).freeze).toBe(true);
    expect(at(5.75).delayMix).toBe(1);
  });

  test("Subtle keeps the loop, the ride and the drop — not the roll or the breath", () => {
    expect(at(5.6, false).rollBeats).toBe(0);
    expect(at(5.8, false).freeze).toBe(false);
    expect(at(6, false).dropped).toBe(true);
  });
});

describe("choosing the bridge", () => {
  const plan: TransitionPlan = { style: "filter", bars: 8, bassSwapBar: 4, keyMatch: false, score: 0.5, keyKnown: false, confident: true };
  const caps = (o: Partial<StyleCapabilities>): StyleCapabilities => ({ stems: false, fx: true, incomingBody: false, grid: true, lock: false, ...o });

  test("an unmatched pair within bridge range is bridged", () => {
    expect(resolveStyle(plan, caps({ bridge: true }), null)).toBe("tempoBridge");
  });
  test("too far to bridge → the echo out", () => {
    expect(resolveStyle(plan, caps({ bridge: false }), null)).toBe("echoOut");
  });
  test("a matchable pair is never bridged — it blends", () => {
    expect(resolveStyle(plan, caps({ lock: true, bridge: true }), null)).not.toBe("tempoBridge");
  });
  test("no grid, no bridge (the whole move is bar-counted)", () => {
    expect(resolveStyle(plan, caps({ bridge: true, grid: false }), null)).not.toBe("tempoBridge");
  });
});
