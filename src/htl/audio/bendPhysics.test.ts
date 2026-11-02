import { describe, expect, it } from "vitest";
import { stepBend, type BendState } from "./bendPhysics";

const P = { gain: 6, decay: 0.18, max: 0.6 }; // Deck's BEND_GAIN / BEND_DECAY / BEND_MAX
const DT = 1 / 60;
const run = (rolls: number[], s0: BendState = { bend: 0, ringVel: 0 }) => {
  const out: BendState[] = [];
  let s = s0;
  for (const r of rolls) out.push((s = stepBend(s, r, DT, P)));
  return out;
};

describe("stepBend: the ring bends the tempo like a turning flywheel, not a tick counter", () => {
  it("a steady turn settles at the OLD model's steady state (velocity × gain × decay): same strength", () => {
    const v = 0.1; // ring turning at 0.1 rate-seconds per second
    const s = run(new Array(240).fill(v * DT)).at(-1)!;
    expect(s.bend).toBeCloseTo(v * P.gain * P.decay, 3);
  });

  it("a BURST inside one frame is distance, not a spike: same frames, same bend, however the ticks were bunched", () => {
    // 8 ticks of 2.5 ms spread over 4 frames vs all 8 in frame one, then quiet.
    // Total extra travel is what must match, so run past the full decay (a short window favours the
    // burst simply because its distance arrives earlier — the first version of this test did that).
    const tail = new Array(300).fill(0);
    const spread = run([0.005, 0.005, 0.005, 0.005, ...tail]);
    const burst = run([0.02, 0, 0, 0, ...tail]);
    const peak = (xs: BendState[]) => Math.max(...xs.map((x) => x.bend));
    const area = (xs: BendState[]) => xs.reduce((a, x) => a + x.bend * DT, 0);
    expect(peak(burst)).toBeLessThan(peak(spread) * 2.5); // bounded, no per-tick jump
    expect(area(burst)).toBeCloseTo(area(spread), 3);
  });

  it("a single nudge adds about gain × decay × its roll of extra travel, like the old model", () => {
    const roll = 0.0025; // one FLX4 tick
    const xs = run([roll, ...new Array(300).fill(0)]);
    const extra = xs.reduce((a, x) => a + x.bend * DT, 0);
    expect(extra).toBeGreaterThan(roll * P.gain * P.decay * 0.6);
    expect(extra).toBeLessThan(roll * P.gain * P.decay * 1.4);
  });

  it("has MOMENTUM: after the ring stops, the bend eases out over the decay time instead of snapping", () => {
    const turning = run(new Array(60).fill(0.1 * DT));
    const held = turning.at(-1)!.bend;
    const after = run(new Array(11).fill(0), turning.at(-1)!); // ~0.18 s later
    expect(after[0].bend).toBeGreaterThan(held * 0.8); // not dropped on the first quiet frame
    expect(after.at(-1)!.bend).toBeLessThan(held * 0.6); // but clearly on its way home
  });

  it("a turn is felt within a few frames, not after the whole decay", () => {
    const up = run(new Array(3).fill(0.1 * DT)).at(-1)!.bend;
    const steady = 0.1 * P.gain * P.decay;
    expect(up).toBeGreaterThan(steady * 0.1); // within ~50 ms, already a real share of the push
  });

  it("reversing the ring reverses the bend promptly", () => {
    const fwd = run(new Array(30).fill(0.1 * DT)).at(-1)!;
    const back = run(new Array(12).fill(-0.1 * DT), fwd).at(-1)!;
    expect(back.bend).toBeLessThan(0);
  });

  it("CONTROL: never exceeds the clamp, and comes fully to rest (zero) when left alone", () => {
    const hard = run(new Array(60).fill(5 * DT));
    expect(Math.max(...hard.map((x) => Math.abs(x.bend)))).toBeLessThanOrEqual(P.max);
    const rest = run(new Array(600).fill(0), hard.at(-1)!).at(-1)!;
    expect(rest).toEqual({ bend: 0, ringVel: 0 });
  });
});
