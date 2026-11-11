import { describe, it, expect } from "vitest";
import { deckSnapshot, fxDiffers, reconcileDeck, type SnapshotDeck } from "./deckApply";
import type { DeckMeta } from "../components/DeckLane";
import type { Beatgrid } from "../htl/analysis/analyze";
import type { SnapField } from "../htl/room/snapshotRepair";
import { padsSnapshotOf, regionArrFromSnapshot } from "../components/useSampler";
import type { SessionSnapshot } from "../htl/state/session";

// Operator, 2026-11-11: session sync audit. The follower's reconcile runs on EVERY newer snapshot now,
// so it must be idempotent and must not overwrite a field this device is editing.

type Stem = "drums" | "bass" | "vocals" | "other";

class FakeDeck implements SnapshotDeck {
  calls: string[] = [];
  tempo = 0;
  trim = 1;
  level = 1;
  eqLow = 0;
  eqMid = 0;
  eqHigh = 0;
  eqLowFreq = 100;
  eqMidFreq = 1000;
  eqHighFreq = 8000;
  eqMidQ = 1;
  eqLowQ = 1;
  eqHighQ = 1;
  eqLowShape = 1;
  eqMidShape = 0;
  eqHighShape = 2;
  eqHpFreq = 20;
  eqHpQ = 0.7;
  eqLpFreq = 20000;
  eqLpQ = 0.7;
  eqBypassed = false;
  eqMix = 1;
  eqOut = 0;
  filterValue = 0;
  keylock = false;
  pitch = 0;
  quantizing = false;
  playing = false;
  ownStems = false;
  remoteStems = false;
  stemsNeural = false;
  beatgrid: Beatgrid | null = null;
  skipBeats = 4;
  cuePoint = 0;
  hotCues: (number | null)[] = new Array(16).fill(null);
  hotLoops: ({ active: boolean; start: number; end: number; beats: number } | null)[] = new Array(16).fill(null);
  loop: { active: boolean; start: number; end: number; beats: number } | null = null;
  loopInPoint: number | null = null;
  fx: { kind: string; bypassed: boolean; params: Record<string, number> }[] = [{ kind: "eq", bypassed: false, params: {} }];
  chains: { name: string; stems: number; devices: { kind: string; bypassed: boolean; params: Record<string, number> }[] }[] = [];
  gains: Record<Stem, number> = { drums: 1, bass: 1, vocals: 1, other: 1 };
  mutes: Record<Stem, boolean> = { drums: false, bass: false, vocals: false, other: false };
  private rec(name: string) {
    this.calls.push(name);
  }
  fxSnapshot() {
    return this.fx.map((f) => ({ ...f, params: { ...f.params } }));
  }
  fxChainSnapshot() {
    return this.chains.map((c) => ({ ...c, devices: c.devices.map((d) => ({ ...d })) }));
  }
  position() {
    return 12.5;
  }
  stemLevel(n: Stem) {
    return this.gains[n];
  }
  stemActive(n: Stem) {
    return !this.mutes[n];
  }
  setTempo(v: number) {
    this.rec("setTempo");
    this.tempo = v;
  }
  setTrim(v: number) {
    this.rec("setTrim");
    this.trim = v;
  }
  setLevel(v: number) {
    this.rec("setLevel");
    this.level = v;
  }
  setEqLow(v: number) {
    this.rec("setEqLow");
    this.eqLow = v;
  }
  setEqMid(v: number) {
    this.rec("setEqMid");
    this.eqMid = v;
  }
  setEqHigh(v: number) {
    this.rec("setEqHigh");
    this.eqHigh = v;
  }
  setEqLowFreq(v: number) {
    this.eqLowFreq = v;
  }
  setEqMidFreq(v: number) {
    this.eqMidFreq = v;
  }
  setEqHighFreq(v: number) {
    this.eqHighFreq = v;
  }
  setEqMidQ(v: number) {
    this.eqMidQ = v;
  }
  setEqLowQ(v: number) {
    this.eqLowQ = v;
  }
  setEqHighQ(v: number) {
    this.eqHighQ = v;
  }
  setEqLowShape(v: number) {
    this.eqLowShape = v;
  }
  setEqMidShape(v: number) {
    this.eqMidShape = v;
  }
  setEqHighShape(v: number) {
    this.eqHighShape = v;
  }
  setEqHpFreq(v: number) {
    this.eqHpFreq = v;
  }
  setEqHpQ(v: number) {
    this.eqHpQ = v;
  }
  setEqLpFreq(v: number) {
    this.eqLpFreq = v;
  }
  setEqLpQ(v: number) {
    this.eqLpQ = v;
  }
  setEqBypass(on: boolean) {
    this.eqBypassed = on;
  }
  setEqMix(v: number) {
    this.eqMix = v;
  }
  setEqOut(v: number) {
    this.eqOut = v;
  }
  setFilter(v: number) {
    this.rec("setFilter");
    this.filterValue = v;
  }
  setKeylock(on: boolean) {
    this.rec("setKeylock");
    this.keylock = on;
  }
  setPitch(s: number) {
    this.rec("setPitch");
    this.pitch = s;
  }
  setQuantize(on: boolean) {
    this.rec("setQuantize");
    this.quantizing = on;
  }
  applyFxSnapshot() {
    this.rec("applyFxSnapshot");
  }
  applyFxChainSnapshot() {
    this.rec("applyFxChainSnapshot");
  }
  markRemoteStems(has: boolean, neural: boolean) {
    this.rec("markRemoteStems");
    this.remoteStems = has;
    this.stemsNeural = has && neural;
  }
  setStemGain(n: Stem, v: number) {
    this.rec("setStemGain");
    this.gains[n] = v;
  }
  setStemMute(n: Stem, on: boolean) {
    this.rec("setStemMute");
    this.mutes[n] = on;
  }
  seek() {
    this.rec("seek");
  }
  play() {
    this.rec("play");
  }
}

const meta: DeckMeta = { name: "T", artist: "A", bpm: 124, duration: 300 } as unknown as DeckMeta;
const never = () => false;

function anchorDeck(): FakeDeck {
  const d = new FakeDeck();
  d.tempo = 3.5;
  d.eqLow = -26; // an auto-DJ bass kill
  d.filterValue = -0.4; // a filter sweep
  d.pitch = 2;
  d.keylock = true;
  d.quantizing = true;
  d.skipBeats = 8;
  d.cuePoint = 41.2;
  d.hotCues[0] = 10;
  d.hotCues[3] = 77.7;
  d.hotLoops[1] = { active: false, start: 20, end: 22, beats: 4 };
  d.loop = { active: true, start: 60, end: 61.875, beats: 4 };
  d.loopInPoint = 60;
  d.mutes.vocals = true;
  d.gains.drums = 0.6;
  d.fx = [
    { kind: "eq", bypassed: false, params: {} },
    { kind: "reverb", bypassed: false, params: { mix: 0.3 } },
  ];
  d.beatgrid = { bpm: 124, firstBeat: 0.21, interval: 60 / 124, beats: Float32Array.from([0.21, 0.694, 1.178, 1.662]), downbeat: 0, beatsPerBar: 4 };
  return d;
}

describe("reconcileDeck — the follower's repair", () => {
  it("round trip: deckSnapshot(anchor) → reconcileDeck(follower) makes the follower match, incl. skipBeats and the grid", () => {
    const snap = JSON.parse(JSON.stringify(deckSnapshot(anchorDeck(), meta, "vid1")));
    const f = new FakeDeck();
    f.beatgrid = { bpm: 123.9, firstBeat: 0.25, interval: 60 / 123.9 }; // its own analysis disagrees
    reconcileDeck(f, snap, never, false);
    const back = JSON.parse(JSON.stringify(deckSnapshot(f, meta, "vid1")));
    // everything but the FX (the caller applies those) and the playhead now matches
    for (const k of ["tempo", "eqLow", "filter", "pitchSemis", "keylock", "quantize", "skipBeats", "cuePoint", "hotCues", "hotLoops", "loop", "loopInPoint", "stemGains", "stemMutes", "grid"]) {
      expect(back[k], k).toEqual(snap[k]);
    }
    expect(f.beatgrid!.bpm).toBe(124);
    expect(fxDiffers(f, snap)).toBe(true); // the rack differs → the caller rebuilds it
  });

  it("IDEMPOTENT: a second pass with the same snapshot calls no setter at all", () => {
    const snap = JSON.parse(JSON.stringify(deckSnapshot(anchorDeck(), meta, "vid1")));
    const f = new FakeDeck();
    reconcileDeck(f, snap, never, false);
    f.calls = [];
    const wrote = reconcileDeck(f, snap, never, false);
    expect(wrote).toEqual([]);
    expect(f.calls).toEqual([]);
  });

  it("an equal FX rack is not touched", () => {
    const a = anchorDeck();
    const snap = JSON.parse(JSON.stringify(deckSnapshot(a, meta, "vid1")));
    const f = new FakeDeck();
    f.fx = a.fxSnapshot();
    expect(fxDiffers(f, snap)).toBe(false);
  });

  it("TOUCH GRACE: a field this device is editing is left alone; the rest is repaired", () => {
    const snap = JSON.parse(JSON.stringify(deckSnapshot(anchorDeck(), meta, "vid1")));
    const f = new FakeDeck();
    f.filterValue = 0.7; // our own sweep in flight
    f.loop = { active: true, start: 1, end: 2, beats: 2 }; // our own loop in flight
    const held = (x: SnapField) => x === "filter" || x === "loop";
    const wrote = reconcileDeck(f, snap, held, false);
    expect(f.filterValue).toBe(0.7);
    expect(f.loop).toEqual({ active: true, start: 1, end: 2, beats: 2 });
    expect(wrote).toContain("tempo");
    expect(wrote).not.toContain("filter");
    expect(wrote).not.toContain("loop");
  });

  it("an empty deck sends no grid", () => {
    const a = anchorDeck();
    expect(deckSnapshot(a, meta, null).grid).toBeUndefined();
  });
});

describe("sampler pads ride the board snapshot", () => {
  it("round trip: padsSnapshotOf → JSON → regionArrFromSnapshot restores the region pads; globals carry their clip ids", () => {
    const regions = {
      vidA: [{ start: 10, end: 12, name: "A1", mode: "loop" as const, gain: 0.8, pitch: 2, stems: ["drums" as const] }, null, null, null, null, null, null, null],
      other: [{ start: 1, end: 2, name: "x", mode: "oneshot" as const, gain: 1 }],
    };
    const globals = [
      { sampleId: "s1", name: "Horn", mode: "oneshot" as const, gain: 1, pitch: -3 },
      { name: "", mode: "oneshot" as const, gain: 1, pitch: 0 },
    ];
    const pads = padsSnapshotOf(regions, globals, { A: "vidA", B: null });
    const board: SessionSnapshot = JSON.parse(JSON.stringify({ decks: {}, crossfade: 0, zoom: { A: 1, B: 1 }, pads }));
    expect(board.pads!.regions!.B).toBeUndefined(); // only the tracks on the decks
    expect(board.pads!.regions!.A!.vid).toBe("vidA");
    expect(regionArrFromSnapshot(board.pads!.regions!.A!.pads)).toEqual(regions.vidA);
    expect(board.pads!.globals).toEqual([{ sampleId: "s1", name: "Horn", mode: "oneshot", gain: 1, pitch: -3 }, null]);
  });
});
