import { describe, it, expect } from "vitest";
import { logMap, SyncRate, GATE_DIVS } from "./fxDsp";

describe("logMap", () => {
  it("returns a function", () => {
    expect(typeof logMap(20, 20000)).toBe("function");
  });
  it("hits min at ext=0 and max at ext=1", () => {
    const f = logMap(20, 20000);
    expect(f(0)).toBeCloseTo(20, 6);
    expect(f(1)).toBeCloseTo(20000, 6);
  });
  it("is the geometric mean at the midpoint", () => {
    const min = 20;
    const max = 20000;
    const f = logMap(min, max);
    expect(f(0.5)).toBeCloseTo(Math.sqrt(min * max), 4);
  });
  it("is monotonic increasing across ext", () => {
    const f = logMap(20, 20000);
    let prev = f(0);
    for (let e = 0.05; e <= 1; e += 0.05) {
      const v = f(e);
      expect(v).toBeGreaterThan(prev);
      prev = v;
    }
  });
  it("clamps ext into [0,1] (no extrapolation past endpoints)", () => {
    const f = logMap(20, 20000);
    expect(f(-1)).toBeCloseTo(20, 6);
    expect(f(2)).toBeCloseTo(20000, 6);
  });
});

describe("SyncRate", () => {
  // freeHz: simple linear map 1..10 Hz for predictability
  const freeHz = (ext: number) => 1 + ext * 9;

  it("returns the free knob value when not synced", () => {
    const r = new SyncRate(GATE_DIVS, freeHz, 0.1, 50, 0.5);
    expect(r.sync).toBe(false);
    expect(r.hz()).toBeCloseTo(freeHz(0.5), 6);
  });

  it("clamps the constructor ext into [0,1]", () => {
    expect(new SyncRate(GATE_DIVS, freeHz, 0.1, 50, 5).ext).toBe(1);
    expect(new SyncRate(GATE_DIVS, freeHz, 0.1, 50, -5).ext).toBe(0);
  });

  it("setRate clamps and updates ext", () => {
    const r = new SyncRate(GATE_DIVS, freeHz, 0.1, 50);
    r.setRate(0.25);
    expect(r.ext).toBe(0.25);
    r.setRate(2);
    expect(r.ext).toBe(1);
  });

  it("when synced, hz() = bpm/60 / beats of the indexed division", () => {
    const r = new SyncRate(GATE_DIVS, freeHz, 0.01, 1000, 0);
    r.setSync(true);
    r.setBpm(120); // 2 beats/sec
    // ext=0 → divIndex 0 → GATE_DIVS[0] "1/4" beats=1 → 2/1 = 2 Hz
    expect(r.hz()).toBeCloseTo(2, 6);
    // ext=1 → last division "1/32" beats=0.125 → 2/0.125 = 16 Hz
    r.setRate(1);
    expect(r.hz()).toBeCloseTo(16, 6);
  });

  it("synced hz() is clamped into [lo, hi]", () => {
    const r = new SyncRate(GATE_DIVS, freeHz, 0.1, 5, 1);
    r.setSync(true);
    r.setBpm(120); // would be 16 Hz unclamped at ext=1
    expect(r.hz()).toBe(5); // clamped to hi
  });

  it("setBpm returns false when not synced even if bpm changed", () => {
    const r = new SyncRate(GATE_DIVS, freeHz, 0.1, 50);
    expect(r.setBpm(140)).toBe(false);
  });

  it("setBpm returns true only when synced AND bpm actually moved", () => {
    const r = new SyncRate(GATE_DIVS, freeHz, 0.1, 50);
    r.setSync(true);
    expect(r.setBpm(140)).toBe(true); // moved from default 120
    expect(r.setBpm(140)).toBe(false); // unchanged (< 0.01 delta)
    expect(r.setBpm(0)).toBe(false); // non-positive ignored
  });

  it("divLabel reflects the indexed division", () => {
    const r = new SyncRate(GATE_DIVS, freeHz, 0.1, 50, 0);
    expect(r.divLabel).toBe(GATE_DIVS[0].label);
    r.setRate(1);
    expect(r.divLabel).toBe(GATE_DIVS[GATE_DIVS.length - 1].label);
  });
});
