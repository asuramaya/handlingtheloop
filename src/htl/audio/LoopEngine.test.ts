import { describe, it, expect } from "vitest";
import { LoopEngine, type LoopHost, HOT_CUE_COUNT } from "./LoopEngine";
import type { Beatgrid } from "../analysis/analyze";

// LoopEngine owns all the loop/cue/hot-cue STATE + editing logic and reaches the deck only through
// the narrow LoopHost callback interface — so a fake host gives full, deterministic coverage of the
// set/jump-cue, hot-cue, beat-loop, manual IN/OUT, roll, move, and fine-adjust behaviour. This is
// the automated form of the owed post-extraction (a4f30f7) smoke-test (task #53).

const GRID: Beatgrid = { bpm: 120, firstBeat: 0, interval: 0.5, beatsPerBar: 4 }; // 120 BPM uniform

function harness(over: Partial<{ pos: number; grid: Beatgrid | null; quant: boolean; play: boolean; load: boolean; dur: number; raw: number }> = {}) {
  const s = { pos: 0, grid: null as Beatgrid | null, quant: false, play: false, load: true, dur: 100, raw: 0, ...over };
  const calls = { seek: [] as number[], postLoop: [] as { active: boolean; start: number; end: number }[], reanchor: 0, rebase: 0, loopEdit: 0 };
  const host: LoopHost = {
    position: () => s.pos,
    seek: (t) => {
      calls.seek.push(t);
      s.pos = t;
    },
    reanchorClock: () => void calls.reanchor++,
    rebaseClock: () => void calls.rebase++,
    rawOffset: () => s.raw,
    postLoop: (active, start, end) => void calls.postLoop.push({ active, start, end }),
    beatgrid: () => s.grid,
    duration: () => s.dur,
    playing: () => s.play,
    loaded: () => s.load,
    quantize: () => s.quant,
    onLoopEdit: () => void calls.loopEdit++,
  };
  return { le: new LoopEngine(host), s, calls };
}
const lastLoop = (calls: ReturnType<typeof harness>["calls"]) => calls.postLoop[calls.postLoop.length - 1];

describe("cue", () => {
  it("setCue captures the playhead; jumpToCue seeks to it", () => {
    const { le, s, calls } = harness({ pos: 12.3 });
    le.setCue();
    expect(le.cuePoint).toBe(12.3);
    s.pos = 50;
    le.jumpToCue();
    expect(calls.seek.at(-1)).toBe(12.3);
  });
  it("snaps the cue to the grid when quantize is on", () => {
    const { le } = harness({ pos: 10.2, grid: GRID, quant: true });
    le.setCue();
    expect(le.cuePoint).toBe(10); // nearest 0.5-beat
  });
});

describe("hot cues — tap empty to set, tap set to jump", () => {
  it("first tap sets at the playhead, second tap jumps there", () => {
    const { le, s, calls } = harness({ pos: 8 });
    le.hotCue(0);
    expect(le.hotCues[0]).toBe(8);
    s.pos = 40;
    le.hotCue(0);
    expect(calls.seek.at(-1)).toBe(8);
  });
  it("clearHotCue frees the slot (cue AND any saved loop)", () => {
    const { le } = harness({ pos: 5 });
    le.hotCue(1);
    expect(le.slotIsSet(1)).toBe(true);
    le.clearHotCue(1);
    expect(le.hotCues[1]).toBeNull();
    expect(le.slotIsSet(1)).toBe(false);
  });
  it("has exactly HOT_CUE_COUNT slots", () => {
    const { le } = harness();
    expect(le.hotCues).toHaveLength(HOT_CUE_COUNT);
  });
});

describe("beat loops", () => {
  it("drops a loop of N beats at the playhead and posts the window", () => {
    const { le, calls } = harness({ pos: 10 }); // no grid → 0.5s/beat fallback
    le.setBeatLoop(4);
    expect(le.loop).toMatchObject({ active: true, start: 10, end: 12, beats: 4 });
    expect(lastLoop(calls)).toEqual({ active: true, start: 10, end: 12 });
    expect(calls.reanchor).toBeGreaterThan(0); // phase-locked before the bounds change
  });
  it("resizing an ACTIVE loop keeps the in-point anchored (rekordbox)", () => {
    const { le } = harness({ pos: 10 });
    le.setBeatLoop(4); // start 10, end 12
    le.setBeatLoop(2); // resize in place, NOT at a new playhead
    expect(le.loop).toMatchObject({ start: 10, end: 11, beats: 2 });
  });
  it("never collapses to a degenerate window (MIN_LOOP floor)", () => {
    const { le, calls } = harness({ pos: 10 });
    le.setBeatLoop(0); // would be a zero-length loop
    const l = le.loop!;
    expect(l.end).toBeGreaterThan(l.start);
    expect(lastLoop(calls).active).toBe(true); // still a valid posted window
  });
  it("bails when nothing is loaded", () => {
    const { le } = harness({ load: false });
    le.setBeatLoop(4);
    expect(le.loop).toBeNull();
  });
  it("keeps a playing playhead inside a shrunk loop", () => {
    const { le, s, calls } = harness({ pos: 10, play: true });
    le.setBeatLoop(8); // 10..14
    s.pos = 13.5;
    le.setBeatLoop(1); // 10..10.5 — playhead now past the end
    expect(calls.seek.at(-1)).toBe(10); // pulled back to start
  });
});

describe("manual FLX4 loop (IN / OUT)", () => {
  it("IN drops a pending in-point, OUT closes the loop", () => {
    const { le, s } = harness({ pos: 10 });
    le.loopIn();
    expect(le.loopInPoint).toBe(10);
    expect(le.loop).toBeNull();
    s.pos = 14;
    le.loopOut();
    expect(le.loop).toMatchObject({ active: true, start: 10, end: 14 });
    expect(le.loopInPoint).toBeNull();
  });
  it("OUT before IN does nothing", () => {
    const { le } = harness({ pos: 10 });
    le.loopOut();
    expect(le.loop).toBeNull();
  });
  it("OUT at/behind the in-point is rejected (no inverted loop)", () => {
    const { le, s } = harness({ pos: 10 });
    le.loopIn();
    s.pos = 9;
    le.loopOut();
    expect(le.loop).toBeNull();
  });
  it("IN/OUT on an ACTIVE loop nudge its boundaries", () => {
    const { le, s } = harness({ pos: 10 });
    le.loopIn();
    s.pos = 14;
    le.loopOut(); // loop 10..14
    s.pos = 11;
    le.loopIn(); // nudge the in-point forward
    expect(le.loop!.start).toBe(11);
    s.pos = 16;
    le.loopOut(); // nudge the out-point back
    expect(le.loop!.end).toBe(16);
  });
});

describe("saved loops on pads", () => {
  it("saveLoop stores the current loop; recall via hotCue activates + seeks to start", () => {
    const { le, calls } = harness({ pos: 10 });
    le.setBeatLoop(4); // 10..12
    expect(le.saveLoop(3)).toBe(true);
    le.exitLoop();
    le.hotCue(3); // a saved loop takes priority → recall
    expect(le.loop).toMatchObject({ active: true, start: 10, end: 12 });
    expect(calls.seek.at(-1)).toBe(10);
  });
  it("saveLoop with no loop returns false", () => {
    const { le } = harness();
    expect(le.saveLoop(0)).toBe(false);
  });
});

describe("loop transport — reloop / toggle / exit / roll / clear", () => {
  it("exitLoop deactivates + rebases the clock; reloop re-activates + seeks to start", () => {
    const { le, calls } = harness({ pos: 10 });
    le.setBeatLoop(4);
    le.exitLoop();
    expect(le.loop!.active).toBe(false);
    expect(calls.rebase).toBeGreaterThan(0);
    le.reloop();
    expect(le.loop!.active).toBe(true);
    expect(calls.seek.at(-1)).toBe(10);
  });
  it("toggleLoop flips active and posts the matching window", () => {
    const { le, calls } = harness({ pos: 10 });
    le.setBeatLoop(4);
    le.toggleLoop();
    expect(le.loop!.active).toBe(false);
    expect(lastLoop(calls).active).toBe(false);
    le.toggleLoop();
    expect(le.loop!.active).toBe(true);
  });
  it("rollOut jumps to the un-wrapped (raw) offset so the music snaps back on-beat", () => {
    const { le, calls } = harness({ pos: 11, play: true, raw: 23.4, dur: 100 });
    le.setBeatLoop(4);
    le.rollOut();
    expect(le.loop!.active).toBe(false);
    expect(calls.seek.at(-1)).toBe(23.4);
  });
  it("clearLoop wipes the region and any pending in-point", () => {
    const { le } = harness({ pos: 10 });
    le.setBeatLoop(4);
    le.clearLoop();
    expect(le.loop).toBeNull();
    expect(le.loopInPoint).toBeNull();
  });
});

describe("session sync — applyLoopRegion / moveLoop", () => {
  it("applyLoopRegion sets an absolute region; rejects inverted", () => {
    const { le } = harness();
    le.applyLoopRegion(20, 24, true);
    expect(le.loop).toMatchObject({ active: true, start: 20, end: 24 });
    le.applyLoopRegion(30, 30, true); // end <= start → ignored
    expect(le.loop!.start).toBe(20);
  });
  it("moveLoop shifts the window keeping its length, clamped to the track, and broadcasts", () => {
    const { le, calls } = harness({ pos: 10, grid: GRID });
    le.setBeatLoop(4); // 10..12 (len 2)
    le.moveLoop(4); // +4 beats = +2s → 12..14
    expect(le.loop).toMatchObject({ start: 12, end: 14 });
    expect(calls.loopEdit).toBeGreaterThan(0);
  });
});

describe("fine-adjust state machine (Shift-IN / Shift-OUT)", () => {
  it("toggles arm on/off and disarms on a repeat of the same boundary", () => {
    const { le } = harness({ pos: 10 });
    le.setBeatLoop(4);
    expect(le.toggleAdjust("in")).toBe("in");
    expect(le.toggleAdjust("in")).toBeNull(); // repeat → off
    expect(le.toggleAdjust("out")).toBe("out");
  });
  it("OUT with only a pending in-point closes the loop first so there's an end to nudge", () => {
    const { le, s } = harness({ pos: 10 });
    le.loopIn(); // pending in-point at 10
    s.pos = 14;
    expect(le.toggleAdjust("out")).toBe("out");
    expect(le.loop).toMatchObject({ start: 10, end: 14 });
  });
  it("adjustStep moves the armed boundary; quantize off = a fine fraction of a beat", () => {
    const { le } = harness({ pos: 10, grid: GRID, quant: false });
    le.setBeatLoop(4); // 10..12
    le.toggleAdjust("out");
    le.adjustStep(1); // +1 unit × interval(0.5) × 1/16 = +0.03125
    expect(le.loop!.end).toBeCloseTo(12.03125, 5);
  });
});

describe("applyLoop validity gate", () => {
  it("posts no-loop for a degenerate / inactive window", () => {
    const { le, calls } = harness({ pos: 10 });
    le.setBeatLoop(4);
    le.exitLoop(); // inactive → invalid
    expect(lastLoop(calls)).toEqual({ active: false, start: 0, end: 0 });
  });
});
