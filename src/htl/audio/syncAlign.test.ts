import { describe, expect, it } from "vitest";
import { beatPhase, commonPhaseError, type Beatgrid } from "../analysis/analyze";
import { phaseAlignedStart } from "./syncAlign";

const comb = (bpm: number, firstBeat: number, dynamic = false, wobble = 0): Beatgrid => {
  const interval = 60 / bpm;
  const g: Beatgrid = { bpm, firstBeat, interval } as Beatgrid;
  if (dynamic) {
    const beats = new Float32Array(400);
    let t = firstBeat;
    for (let i = 0; i < beats.length; i++) {
      beats[i] = t;
      t += interval * (1 + wobble * Math.sin(i / 5));
    }
    g.beats = beats;
  }
  return g;
};

const err = (self: { grid: Beatgrid; pos: number; rate: number }, other: { grid: Beatgrid; pos: number; rate: number }) => {
  const fold = (self.rate * self.grid.bpm) / (other.rate * other.grid.bpm);
  return commonPhaseError(beatPhase(self.grid, self.pos), beatPhase(other.grid, other.pos), fold);
};

describe("phaseAlignedStart: a synced deck starts in phase", () => {
  const master = { grid: comb(128, 0.31), pos: 47.123, rate: 1 };

  it("lands on the master's phase from anywhere, moving at most half a beat", () => {
    const sg = comb(124, 0.07);
    const rate = 128 / 124; // tempo-matched, as SYNC leaves it
    for (let k = 0; k < 40; k++) {
      const pos = 20 + k * 0.0371; // sweep through every phase
      const out = phaseAlignedStart({ grid: sg, pos, rate }, master);
      expect(Math.abs(err({ grid: sg, pos: out, rate }, master))).toBeLessThan(0.002);
      expect(Math.abs(out - pos)).toBeLessThanOrEqual(sg.interval * 0.5 + 1e-6);
    }
  });

  it("handles a half/double-time pair (87 against 174) at the audible beat", () => {
    const sg = comb(87, 0.2);
    const fast = { grid: comb(174, 0.05), pos: 33.3, rate: 1 };
    const rate = 1; // 87 × 2 = 174: an octave, already matched
    const pos = 50.0;
    const out = phaseAlignedStart({ grid: sg, pos, rate }, fast);
    expect(Math.abs(err({ grid: sg, pos: out, rate }, fast))).toBeLessThan(0.002);
    expect(Math.abs(out - pos)).toBeLessThanOrEqual(sg.interval / 2 / 2 + 1e-6); // half of the AUDIBLE beat
  });

  it("is accurate on a dynamic (tracked, drifting) grid", () => {
    const sg = comb(120, 0.1, true, 0.03);
    const rate = 128 / 120;
    for (const pos of [12.34, 40.5, 77.77]) {
      const out = phaseAlignedStart({ grid: sg, pos, rate }, master);
      expect(Math.abs(err({ grid: sg, pos: out, rate }, master))).toBeLessThan(0.01);
    }
  });

  it("leaves an already-aligned start exactly where it is", () => {
    const sg = comb(128, 0.31);
    expect(phaseAlignedStart({ grid: sg, pos: 47.123, rate: 1 }, master)).toBeCloseTo(47.123, 6);
  });

  it("does nothing with an unusable grid", () => {
    const bad = { bpm: 0, firstBeat: 0, interval: 0 } as Beatgrid;
    expect(phaseAlignedStart({ grid: bad, pos: 10, rate: 1 }, master)).toBe(10);
    expect(phaseAlignedStart({ grid: comb(120, 0), pos: 10, rate: 1 }, { ...master, grid: bad })).toBe(10);
  });
});
