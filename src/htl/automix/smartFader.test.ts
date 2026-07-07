import { describe, test, expect, beforeEach } from "vitest";
// Smart Fader regression harness. The crossfader-driven transition has no AudioContext/DOM needs —
// it reaches the engine only through the methods faked below — so we can drive a whole throw and
// assert the ONE thing that silently regressed in prod: the tempo morph must fold the incoming BPM
// into the LIVE deck's octave (a ≤√2 move) instead of ramping the master RAW to the incoming's
// natural BPM. A raw ramp across a genre gap crosses a half/double fold boundary, where the SYNC
// slave's own folded target discontinuously halves/doubles — the "jumps BPM drastically / can't
// sync" fail. See smartFader.ts setupDirection + foldTempoOctave.
import { SmartFader } from "./smartFader";
import type { AudioEngine } from "../audio/AudioEngine";
import type { DeckId } from "../audio/index";

class FakeDeck {
  playing = false;
  keylock = true;
  keylockPinnedOff = false;
  effectiveBpm: number | undefined;
  beatgrid: { bpm: number } | null = null;
  tempoPct = 0; // last setTempo() argument (percent)
  tempoLog: number[] = []; // every setTempo() call, in order
  play(): void {
    this.playing = true;
  }
  setTempo(v: number): void {
    this.tempoPct = v;
    this.tempoLog.push(v);
  }
  setEqLow(): void {}
  setKeylock(v: boolean): void {
    this.keylock = v;
  }
  setKeylockPinnedOff(on: boolean): void {
    this.keylockPinnedOff = on;
    if (on) this.keylock = false;
  }
}

class FakeEngine {
  A = new FakeDeck();
  B = new FakeDeck();
  commandedRamp = false;
  crossfade = 0;
  private syncSlave: Record<DeckId, boolean> = { A: false, B: false };
  deck(id: DeckId): FakeDeck {
    return id === "A" ? this.A : this.B;
  }
  setCommandedRamp(on: boolean): void {
    this.commandedRamp = on;
  }
  setCrossfade(cf: number): void {
    this.crossfade = cf;
  }
  syncRole(id: DeckId): string {
    return this.syncSlave[id] ? "slave" : "off";
  }
  toggleSync(id: DeckId): void {
    this.syncSlave[id] = !this.syncSlave[id];
  }
}

// BPM the master would be commanded to at percent `pct` off base `base`.
const bpmAt = (base: number, pct: number) => base * (1 + pct / 100);

describe("SmartFader tempo morph fold", () => {
  let eng: FakeEngine;
  let sf: SmartFader;
  beforeEach(() => {
    eng = new FakeEngine();
    sf = new SmartFader(eng as unknown as AudioEngine);
  });

  test("a genre gap (120 → 174) folds into the live octave, not a raw +45% ramp", () => {
    eng.A.beatgrid = { bpm: 120 };
    eng.A.effectiveBpm = 120;
    eng.A.playing = true;
    eng.B.beatgrid = { bpm: 174 };
    eng.B.effectiveBpm = 174;

    expect(sf.arm(-1)).toBe(true); // full on A (the live deck) → throw begins at p=0
    // Halfway through the throw the master must sit inside A's octave band [120/√2, 120·√2] ≈
    // [84.9, 169.7]; the buggy raw ramp would command ~147 BPM (+22.5%). Folded target is 87
    // (174/2), so halfway ≈ 103.5 BPM.
    sf.onCrossfade(0);
    const mid = bpmAt(120, eng.A.tempoPct);
    expect(mid).toBeGreaterThan(120 / Math.SQRT2);
    expect(mid).toBeLessThan(120 * Math.SQRT2);
    expect(mid).toBeCloseTo(103.5, 1);

    // Complete the throw: the common tempo lands on the FOLDED incoming BPM (87), i.e. −27.5% off
    // A's base — never the raw +45% that would stretch far past a clean WSOLA range and lurch the
    // slave an octave. A's last commanded tempo is the p→1 value.
    sf.onCrossfade(1);
    const landed = bpmAt(120, eng.A.tempoLog[eng.A.tempoLog.length - 1]);
    expect(Math.abs(landed - 87)).toBeLessThan(2);

    // The deck we faded INTO must land at its OWN natural tempo (0 shift) — explicitly released,
    // not left riding the blend tempo. (B was the incoming/slave; the throw completing releases it.)
    expect(eng.B.tempoPct).toBe(0);
    expect(eng.B.tempoLog.length).toBeGreaterThan(0); // proves the explicit release fired
  });

  test("no boundary crossing: the whole ramp stays within one octave band", () => {
    eng.A.beatgrid = { bpm: 120 };
    eng.A.effectiveBpm = 120;
    eng.A.playing = true;
    eng.B.beatgrid = { bpm: 174 };
    eng.B.effectiveBpm = 174;
    sf.arm(-1);
    // Sweep the fader across the whole throw; every commanded master BPM must stay in the band.
    for (let cf = -1; cf <= 1.0001; cf += 0.1) sf.onCrossfade(Math.min(1, cf));
    for (const pct of eng.A.tempoLog) {
      const bpm = bpmAt(120, pct);
      expect(bpm).toBeGreaterThan(120 / Math.SQRT2 - 0.01);
      expect(bpm).toBeLessThan(120 * Math.SQRT2 + 0.01);
    }
  });

  test("a near pair (124 → 174, within √2) morphs without folding", () => {
    eng.A.beatgrid = { bpm: 124 };
    eng.A.effectiveBpm = 124;
    eng.A.playing = true;
    eng.B.beatgrid = { bpm: 174 };
    eng.B.effectiveBpm = 174;
    sf.arm(-1);
    sf.onCrossfade(1);
    const landed = bpmAt(124, eng.A.tempoLog[eng.A.tempoLog.length - 1]);
    // 174/124 = 1.403 < √2, so no fold — the common tempo reaches the incoming's natural 174.
    expect(Math.abs(landed - 174)).toBeLessThan(2);
  });
});
