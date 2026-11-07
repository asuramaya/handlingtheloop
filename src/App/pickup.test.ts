import { describe, expect, it } from "vitest";
import { pickupStep, scaledTakeover, type PickupState } from "./pickup";

const run = (cur: number, values: number[], relatch = false, st?: PickupState) => {
  const caughtAt: boolean[] = [];
  for (const v of values) {
    st = pickupStep(st, cur, v, relatch);
    caughtAt.push(st.caught);
  }
  return { st: st!, caughtAt };
};

describe("pickupStep: soft takeover", () => {
  it("ignores a control away from the value until it sweeps through it", () => {
    const { caughtAt } = run(0.6, [0.2, 0.3, 0.5, 0.65, 0.7]);
    expect(caughtAt).toEqual([false, false, false, true, true]);
  });

  it("catches a control that starts ON the value and moves off it (it never crosses)", () => {
    // the old rule: a slider resting at centre with the tempo at 0 could be moved forever and never take over
    const { caughtAt } = run(0.5, [0.5, 0.52, 0.55]);
    expect(caughtAt).toEqual([true, true, true]);
  });

  it("a tempo slider lets go when SYNC (or anything else) moves the tempo, then picks up again", () => {
    // caught at 0.5, then tracking: once caught the tempo FOLLOWS the slider, so `cur` follows too
    let st: PickupState | undefined;
    let tempo = 0.5;
    for (const v of [0.5, 0.55, 0.6]) {
      st = pickupStep(st, tempo, v, true);
      if (st.caught) tempo = v;
    }
    expect(st!.caught).toBe(true);
    expect(tempo).toBe(0.6);
    // SYNC moves the tempo to 0.7; the slider is still at 0.6 and is touched
    st = pickupStep(st!, 0.7, 0.61, true);
    expect(st.caught).toBe(false); // no jump to 0.61
    st = pickupStep(st, 0.7, 0.66, true);
    expect(st.caught).toBe(false);
    st = pickupStep(st, 0.7, 0.71, true); // swept through 0.7
    expect(st.caught).toBe(true);
  });

  it("without relatch (an ordinary pickup knob) a caught control stays caught", () => {
    let st = run(0.5, [0.5, 0.6]).st;
    st = pickupStep(st, 0.9, 0.62);
    expect(st.caught).toBe(true);
  });
});

describe("scaledTakeover — a tempo slider with no dead zone and a true midpoint", () => {
  it("an out-of-step slider answers at once, in its own direction, never jumps", () => {
    // slider at 0.7, tempo at 0.5 (a key shift moved the slider, not the tempo)
    let st = scaledTakeover(undefined, 0.5, 0.7);
    expect(st.apply).toBeNull(); // first reading: no jump
    st = scaledTakeover(st, 0.5, 0.68); // down a little, toward the tempo
    expect(st.apply!).toBeLessThan(0.5); // answered, same direction
    expect(st.apply!).toBeCloseTo(0.49, 6); // at half speed while closing in
    st = scaledTakeover(undefined, 0.5, 0.7);
    st = scaledTakeover(st, 0.5, 0.72); // up, away from the tempo
    expect(st.apply!).toBeCloseTo(0.53, 6); // at 1.5× while pulling away
  });

  it("the gap closes after ~2× its width of travel, then the CENTRE is 0 % again", () => {
    let cur = 0.5;
    let st = scaledTakeover(undefined, cur, 0.7); // 0.2 apart
    for (let v = 0.69; v >= 0.25; v -= 0.01) {
      st = scaledTakeover(st, cur, v);
      cur = st.apply ?? cur;
    }
    expect(st.caught).toBe(true);
    for (let v = 0.26; v <= 0.5 + 1e-9; v += 0.01) {
      st = scaledTakeover(st, cur, Math.min(0.5, v));
      cur = st.apply ?? cur;
    }
    expect(cur).toBeCloseTo(0.5, 6); // slider at the middle → tempo at 0 %
  });

  it("a slider resting on the value is caught and tracks 1:1", () => {
    let st = scaledTakeover(undefined, 0.5, 0.5);
    expect(st.caught).toBe(true);
    st = scaledTakeover(st, 0.5, 0.52);
    expect(st.apply).toBe(0.52);
  });
});
