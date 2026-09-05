import { describe, expect, it } from "vitest";
import { GRID_ALPHA, GRID_W, MIN_BAR_PX, gridInk, gridLod } from "./gridLod";

// A zoom sweep, fine enough that a real tier switch cannot hide between samples. 2px/beat is the
// whole song in a lane; 240px/beat is a single beat filling it.
const SWEEP: number[] = [];
for (let px = 2; px <= 240; px += 0.25) SWEEP.push(px);

describe("gridLod over a zoom sweep", () => {
  // ★ THE COMPLAINT, AS A TEST: "we end up with these weird in-between states that cover too much
  // of the song". Both halves are properties of the CURVE, so both are checked across the sweep.
  it("never inks more than a small fraction of the lane", () => {
    let worst = { px: 0, ink: 0 };
    for (const px of SWEEP) {
      const ink = gridInk(px, 4, 4);
      if (ink > worst.ink) worst = { px, ink };
    }
    // The old tiers peaked around 0.17 (measured on the real canvas at 16.15% of the lane).
    expect(worst.ink).toBeLessThan(0.05);
  });

  it("has no jump in density — the collapse is a dissolve, not a cut", () => {
    let worstJump = { px: 0, d: 0 };
    for (let i = 1; i < SWEEP.length; i++) {
      const d = Math.abs(gridInk(SWEEP[i], 4, 4) - gridInk(SWEEP[i - 1], 4, 4));
      if (d > worstJump.d) worstJump = { px: SWEEP[i], d };
    }
    // Per 0.25px of zoom. A hard boolean tier switch shows up here as a step of ~0.01+.
    expect(worstJump.d).toBeLessThan(0.002);
  });

  it("keeps bold lines at least MIN_BAR_PX apart at every zoom", () => {
    for (const px of SWEEP) {
      const { barStep } = gridLod(px, 4, 4);
      expect(px * 4 * barStep).toBeGreaterThanOrEqual(MIN_BAR_PX);
    }
  });

  it("coarsens monotonically as you zoom out", () => {
    let prev = Infinity;
    for (const px of [...SWEEP].reverse()) {
      const { barStep } = gridLod(px, 4, 4);
      expect(barStep).toBeGreaterThanOrEqual(prev === Infinity ? 1 : prev);
      prev = barStep;
    }
  });

  it("fades the finer tiers in, never on", () => {
    // Every fade must pass through intermediate values rather than stepping 0 → 1.
    const partial = { beat: 0, sub: 0, half: 0 };
    for (const px of SWEEP) {
      const l = gridLod(px, 4, 4);
      if (l.beatFade > 0.02 && l.beatFade < 0.98) partial.beat++;
      if (l.subFade > 0.02 && l.subFade < 0.98) partial.sub++;
      if (l.halfFade > 0.02 && l.halfFade < 0.98) partial.half++;
    }
    expect(partial.beat).toBeGreaterThan(10);
    expect(partial.sub).toBeGreaterThan(10);
    expect(partial.half).toBeGreaterThan(10);
  });

  it("a bar line is always the strongest thing on the grid", () => {
    for (const px of SWEEP) {
      const l = gridLod(px, 4, 4);
      expect(GRID_W.bar * GRID_ALPHA.bar).toBeGreaterThan(GRID_W.beat * GRID_ALPHA.beat * l.beatFade);
      expect(GRID_W.beat * GRID_ALPHA.beat).toBeGreaterThan(GRID_W.sub * GRID_ALPHA.sub * l.subFade);
    }
  });

  // ★ A TEST THAT CANNOT FAIL IS NOT A TEST. The two guarantees above are meaningless unless the
  // tiers this replaced would actually break them, so the old rules are reconstructed here and
  // asserted to FAIL both. If a future change makes the new numbers drift back toward the old
  // ones, this is the case that notices.
  it("the tiers this replaced fail both guarantees", () => {
    const oldInk = (pxPerBeat: number, beatsPerBar = 4, subs = 4) => {
      const pxPerBar = pxPerBeat * beatsPerBar;
      let barStep = 1;
      while (pxPerBar * barStep < 22) barStep *= 2;
      const fine = barStep === 1;
      const showBeat = fine && pxPerBeat >= 9;
      const showSub = fine && subs > 1 && pxPerBeat / subs >= 4;
      const scale = 4 / 2; // the operator's own markerThickness of 4, which used to scale the grid
      const span = pxPerBar * barStep;
      let ink = 2.2 * scale * 0.95;
      if (showBeat) ink += (beatsPerBar * barStep - 1) * 1.3 * scale * 0.42;
      if (showSub) ink += beatsPerBar * barStep * (subs - 1) * 1 * scale * 0.16;
      return ink / span;
    };
    let worst = 0;
    let worstJump = 0;
    for (let i = 1; i < SWEEP.length; i++) {
      worst = Math.max(worst, oldInk(SWEEP[i]));
      worstJump = Math.max(worstJump, Math.abs(oldInk(SWEEP[i]) - oldInk(SWEEP[i - 1])));
    }
    expect(worst).toBeGreaterThan(0.05); // covered too much
    expect(worstJump).toBeGreaterThan(0.002); // and got there in one frame
  });
});
