import { describe, expect, it } from "vitest";
import { peak, platterCurves, ringCurve, settleTime } from "./platterCurves";
import { platterDrag } from "@htl/audio/JogEngine";
import { migrateSettings } from "@htl/state/settings";

const base = { mass: 0.4, start: 0.18, brake: 0.22, backSpin: 0.5 };
const curve = (k: Partial<typeof base>, key: string) => platterCurves({ ...base, ...k }).find((c) => c.key === key)!;

describe("platterCurves: the graph says what the deck will do", () => {
  it("Start and Brake at 0 are INSTANT (that is what replaced the motor on/off toggle)", () => {
    expect(curve({ start: 0 }, "play").lines[0].v[1]).toBe(1);
    expect(curve({ brake: 0 }, "pause").lines[0].v[1]).toBe(0);
  });

  it("a longer Start / Brake visibly takes longer", () => {
    const t = (s: number) => settleTime(curve({ start: s }, "play").lines[0].v, 1);
    expect(t(0.8)).toBeGreaterThan(t(0.2));
    const b = (x: number) => settleTime(curve({ brake: x }, "pause").lines[0].v, 0);
    expect(b(0.8)).toBeGreaterThan(b(0.2));
  });

  it("MASS moves both halves of a release: heavier catches up slower AND glides longer", () => {
    const lg = (m: number) => curve({ mass: m }, "letGo").lines;
    expect(settleTime(lg(0.9)[0].v, 1)).toBeGreaterThan(settleTime(lg(0.1)[0].v, 1));
    expect(settleTime(lg(0.9)[1].v, 0)).toBeGreaterThan(settleTime(lg(0.1)[1].v, 0));
  });

  it("CONTROL: the merged mass reproduces the old default drag exactly", () => {
    expect(platterDrag(0.4)).toBeCloseTo(0.4, 10);
  });

  it("back spin throws harder and longer as its knob rises", () => {
    const bs = (x: number) => curve({ backSpin: x }, "backSpin").lines[0].v;
    expect(Math.min(...bs(1))).toBeLessThan(Math.min(...bs(0)));
  });
});

describe("ringCurve: the ring bend tile", () => {
  it("a stronger Ring bend pushes harder, and the push eases back to the set tempo after the turn", () => {
    expect(peak(ringCurve(2).lines[0].v)).toBeGreaterThan(peak(ringCurve(0.5).lines[0].v));
    const v = ringCurve(1).lines[0].v;
    expect(v.at(-1)!).toBeLessThan(peak(v) * 0.1);
  });
});

describe("migrateSettings: nobody's motor changes under them", () => {
  it("a stored motor OFF becomes Start = Brake = 0 (instant), and the toggle is dropped", () => {
    const m = migrateSettings({ vinylSpeed: false, vinylBrakeTime: 0.22, vinylStartTime: 0.18, jogDrag: 0.7 } as never) as Record<string, unknown>;
    expect(m.vinylBrakeTime).toBe(0);
    expect(m.vinylStartTime).toBe(0);
    expect("vinylSpeed" in m).toBe(false);
    expect("jogDrag" in m).toBe(false);
  });

  it("a stored motor ON keeps its times; already-migrated settings pass through unchanged", () => {
    const on = migrateSettings({ vinylSpeed: true, vinylBrakeTime: 0.3, vinylStartTime: 0.4 } as never) as Record<string, unknown>;
    expect(on.vinylBrakeTime).toBe(0.3);
    expect(on.vinylStartTime).toBe(0.4);
    const again = migrateSettings({ vinylBrakeTime: 0.3, vinylStartTime: 0.4 } as never) as Record<string, unknown>;
    expect(again).toEqual({ vinylBrakeTime: 0.3, vinylStartTime: 0.4 });
  });
});
