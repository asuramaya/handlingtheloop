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
import type { Intent } from "../room/protocol";

class FakeDeck {
  playing = false;
  keylock = true;
  keylockPinnedOff = false;
  effectiveBpm: number | undefined;
  beatgrid: { bpm: number } | null = null;
  tempoPct = 0; // last setTempo() argument (percent)
  pitch = 0;
  get tempo(): number {
    return this.tempoPct;
  }
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
  private slaved: Record<DeckId, boolean> = { A: false, B: false };
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
    return this.slaved[id] ? "slave" : "off";
  }
  toggleSync(id: DeckId): void {
    this.slaved[id] = !this.slaved[id];
  }
  get syncSlave(): DeckId | null {
    return this.slaved.A ? "A" : this.slaved.B ? "B" : null;
  }
  takeAlignSeek(): { deck: DeckId; pos: number } | null {
    return this.syncSlave ? { deck: this.syncSlave, pos: 8 } : null;
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

  // ★ ONLY A MATCHABLE PAIR IS MORPHED (analysis tempoLockable, operator 2026-11-04: the smart
  // fader "works completely against it because it cannot sync tempo/bpm"). These two cases used to
  // assert a −27.5 % and a +40 % morph of the outgoing deck; that IS the counterproductive behaviour.
  test("a genre gap (120 → 174) is not beat-matched: both keep their tempo, no SYNC, still a throw", () => {
    eng.A.beatgrid = { bpm: 120 };
    eng.A.effectiveBpm = 120;
    eng.A.playing = true;
    eng.B.beatgrid = { bpm: 174 };
    eng.B.effectiveBpm = 174;
    expect(sf.arm(-1)).toBe(true);
    expect(sf.state().locked).toBe(false);
    for (let cf = -1; cf <= 1.0001; cf += 0.1) sf.onCrossfade(Math.min(1, cf));
    expect(eng.A.tempoLog).toEqual([]); // the outgoing was never dragged
    expect(eng.syncRole("B")).toBe("off");
    expect(eng.B.playing).toBe(true); // the throw still brought the incoming in
    expect(eng.crossfade).toBeCloseTo(1, 6);
    expect(eng.commandedRamp).toBe(false);
    expect(eng.A.keylock).toBe(true); // key-lock left alone: there is no glide to pitch
  });

  test("a near pair (124 → 130) morphs to the incoming's tempo and lands it at its own", () => {
    eng.A.beatgrid = { bpm: 124 };
    eng.A.effectiveBpm = 124;
    eng.A.playing = true;
    eng.B.beatgrid = { bpm: 130 };
    eng.B.effectiveBpm = 130;
    sf.arm(-1);
    expect(sf.state().locked).toBe(true);
    expect(eng.syncRole("B")).toBe("slave");
    sf.onCrossfade(0);
    expect(bpmAt(124, eng.A.tempoPct)).toBeCloseTo(127, 1);
    sf.onCrossfade(1);
    const landed = bpmAt(124, eng.A.tempoLog[eng.A.tempoLog.length - 1]);
    expect(Math.abs(landed - 130)).toBeLessThan(1);
    expect(eng.B.tempoPct).toBe(0); // explicitly released to natural
  });

  test("a double-time pair (120 → 246) still matches in the folded octave, never crossing it", () => {
    eng.A.beatgrid = { bpm: 120 };
    eng.A.effectiveBpm = 120;
    eng.A.playing = true;
    eng.B.beatgrid = { bpm: 246 };
    eng.B.effectiveBpm = 246;
    sf.arm(-1);
    expect(sf.state().locked).toBe(true);
    for (let cf = -1; cf <= 1.0001; cf += 0.1) sf.onCrossfade(Math.min(1, cf));
    for (const pct of eng.A.tempoLog) {
      const bpm = bpmAt(120, pct);
      expect(bpm).toBeGreaterThan(119.9);
      expect(bpm).toBeLessThan(123.1); // 246 folds to 123: a 2.5 % move, not a 2x one
    }
  });

  test("no beat grid: it still arms and throws (crossfade + bass swap), it just does not sync", () => {
    eng.A.playing = true;
    expect(sf.arm(-1)).toBe(true);
    expect(sf.state().locked).toBe(false);
    sf.onCrossfade(0.5);
    expect(eng.B.playing).toBe(true);
    expect(eng.A.tempoLog).toEqual([]);
  });

  test("after AUTO moved the fader, the next throw starts from the deck that is actually live", () => {
    eng.A.beatgrid = { bpm: 124 };
    eng.A.effectiveBpm = 124;
    eng.A.playing = true;
    eng.B.beatgrid = { bpm: 126 };
    eng.B.effectiveBpm = 126;
    sf.arm(-1); // from A
    expect(sf.state().from).toBe("A");
    // AUTO mixes A → B on its own (not through the smart fader) and stops A.
    eng.setCrossfade(1);
    eng.A.playing = false;
    eng.B.playing = true;
    sf.noteExternalCrossfade();
    sf.onCrossfade(0.9); // the hand starts the next throw from the B side
    expect(sf.state().from).toBe("B");
    expect(sf.state().to).toBe("A");
    expect(eng.B.tempoLog.length).toBeGreaterThan(0); // the morph moved B, the live deck — not A
  });

  // ★ operator, 2026-11-11: session sync audit — the throw's SYNC lock was the one move that never
  // reached the wire, so the far side's SYNC button and follower stayed wherever they were.
  test("arming a locked throw SAYS so: the sync role, the tempos and the align seek cross", () => {
    eng.A.beatgrid = { bpm: 124 };
    eng.A.effectiveBpm = 124;
    eng.A.playing = true;
    eng.B.beatgrid = { bpm: 128 };
    eng.B.effectiveBpm = 128;
    const sent: Intent[] = [];
    sf.setEmitter((i) => sent.push(i));
    sf.arm(-1);
    const sync = sent.filter((i) => i.kind === "sync");
    expect(sync).toEqual([{ kind: "sync", slave: "B" }]);
    expect(sent).toContainEqual({ kind: "control", deck: "B", param: "tempo", value: 0, follow: true });
    expect(sent).toContainEqual({ kind: "transport", deck: "B", action: "seek", position: 8 });
  });

  test("arming BECAUSE a co-DJ armed (announce=false) does not echo the lock back", () => {
    eng.A.beatgrid = { bpm: 124 };
    eng.A.effectiveBpm = 124;
    eng.A.playing = true;
    eng.B.beatgrid = { bpm: 128 };
    eng.B.effectiveBpm = 128;
    const sent: Intent[] = [];
    sf.setEmitter((i) => sent.push(i));
    sf.arm(-1, false);
    expect(eng.syncRole("B")).toBe("slave"); // locked here all the same
    expect(sent.some((i) => i.kind === "sync")).toBe(false);
  });

  test("an unlockable pair releases a previous throw's lock and says so", () => {
    eng.A.beatgrid = { bpm: 120 };
    eng.A.effectiveBpm = 120;
    eng.A.playing = true;
    eng.B.beatgrid = { bpm: 174 };
    eng.B.effectiveBpm = 174;
    eng.toggleSync("B"); // a lock left over from before
    const sent: Intent[] = [];
    sf.setEmitter((i) => sent.push(i));
    sf.arm(-1);
    expect(eng.syncRole("B")).toBe("off");
    expect(sent).toContainEqual({ kind: "sync", slave: null });
  });
});
