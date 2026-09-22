import { describe, expect, it, vi } from "vitest";
import { BaseFxDevice, type FxKind } from "./Fx";

// WHEN AN EFFECT GOES OFF, DOES ANYTHING STILL POINT OUT OF ITS WET BUS?
//
// The always-armed rack rests on one claim: bypassing a device leaves its wet graph with no path
// anywhere, so the audio thread prunes it and an off effect costs nothing. The gate that enforces
// that cut `wet → output` and stopped, because a comment said that was the only edge. It was not —
// the constructor also mints `wet → wetMeter`, and a live context keeps the whole upstream of an
// AnalyserNode scheduled even when the analyser reaches nothing (measured with both controls in
// scripts/liveprune.mjs: 0 calls/s cut, 360 with a bare analyser hung on, 0 again once removed).
// So a bypassed comp or reverb went on running its worklet at ~95% of the active cost.
//
// The test is deliberately about the WET NODE'S OUT-EDGES rather than about the meter by name: a
// third tap added later is the same defect again, and this fails on it without being edited. No
// audio here and none claimed — these are stub nodes that record their edges.

class StubNode {
  edges: StubNode[] = [];
  gain = { value: 0, setTargetAtTime: () => {} };
  fftSize = 0;
  smoothingTimeConstant = 0;
  constructor(readonly label: string) {}
  connect(to: StubNode) {
    this.edges.push(to);
    return to;
  }
  disconnect(to?: StubNode) {
    this.edges = to ? this.edges.filter((e) => e !== to) : [];
  }
  getFloatTimeDomainData(buf: Float32Array) {
    buf.fill(0.5); // a meter that always reads LOUD: a stale read must not pass as a live one
  }
}

function rig() {
  let n = 0;
  const ctx = {
    currentTime: 0,
    createGain: () => new StubNode(`g${n++}`),
    createAnalyser: () => new StubNode(`an${n++}`),
  } as unknown as AudioContext;
  class Probe extends BaseFxDevice {
    readonly kind: FxKind = "comp";
    constructor() {
      super(ctx, 1);
    }
    /** The subclass's processing graph — the thing that must end up unreachable. */
    readonly wetBus = (this as unknown as { wet: StubNode }).wet;
  }
  return new Probe();
}

describe("the wet activation gate", () => {
  it("leaves NO edge out of the wet bus once a bypass has settled", () => {
    vi.useFakeTimers();
    try {
      const d = rig();
      expect(d.wetBus.edges.length).toBeGreaterThan(1); // output AND the meter, while it is on
      d.setBypass(true);
      vi.advanceTimersByTime(200); // past the gate's ~90ms prune delay
      expect(d.wetBus.edges).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("restores every one of them when the effect comes back", () => {
    vi.useFakeTimers();
    try {
      const d = rig();
      const armed = d.wetBus.edges.length;
      d.setBypass(true);
      vi.advanceTimersByTime(200);
      d.setBypass(false);
      expect(d.wetBus.edges.length).toBe(armed);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports silence once pruned, not the meter's frozen last frame", () => {
    vi.useFakeTimers();
    try {
      const d = rig();
      expect(d.wetLevel).toBeGreaterThan(0); // the stub meter reads 0.5 while connected
      d.setBypass(true);
      vi.advanceTimersByTime(200);
      expect(d.wetLevel).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
