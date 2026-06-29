import { describe, it, expect } from "vitest";
import { JogEngine, type JogHost } from "./JogEngine";

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// CI for a HARDWARE-driven subsystem, without the hardware — and honest about the boundary.
//
// A controller (the DDJ-FLX4) is just a deterministic byte source. The chain it drives splits into
// layers, each testable to a different degree:
//   1. byte → delta decode .......... PURE, fully CI'd (decode.test.ts)
//   2. profile → MidiEvent dispatch . CI'able by REPLAYING the documented byte map (roadmap)
//   3. MidiEvent → engine STATE ..... THIS FILE — the jog/platter state machine, driven through its
//                                     JogHost callback seam with a fake host (no AudioContext / no
//                                     hardware). In node, requestAnimationFrame is undefined so the
//                                     rAF coast loop is skipped — but the BUG here is a synchronous
//                                     PHASE-GATE, so it's fully reproducible without timing.
//
// What this canNOT prove (stays a real-device ear-test, #51): that the FLX4 actually EMITS the bytes
// the profile assumes (firmware/mode can remap — see htl-flx-hardware-pathology), and that the
// resulting AUDIO feels/sounds right (scratch latency, motor-ramp smoothness). So: the LOGIC is
// CI-locked; the byte-map ground truth + the feel remain hardware-confirmed.
//
// This file pins the contract behind the 2026-06-29 freeze fix (a6eed3c): `grabbing` (active hold)
// is distinct from `scrubbing` (hold + release coast + motor ramp), and a scratch only applies in
// the grab phase — so the CALLER must re-grab to interrupt a coast, or the input is swallowed.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

function harness(over: Partial<{ start: number; playing: boolean; loaded: boolean; dur: number; rate: number; slip: number | null }> = {}) {
  const s = { start: 10, playing: true, loaded: true, dur: 100, rate: 1, slip: null as number | null, ...over };
  const calls = { setStartOffset: [] as number[], spawnSource: [] as number[], stopSource: 0, setPlaying: [] as boolean[], play: 0, pause: 0, clearBend: 0, slipArm: 0, slipArmForce: 0 };
  const host: JogHost = {
    position: () => s.start, //        while jogging the playhead IS the start offset
    startOffset: () => s.start,
    setStartOffset: (v) => void (calls.setStartOffset.push(v), (s.start = v)),
    playing: () => s.playing,
    setPlaying: (v) => void (calls.setPlaying.push(v), (s.playing = v)),
    loaded: () => s.loaded,
    duration: () => s.dur,
    rate: () => s.rate,
    effRate: () => s.rate,
    play: () => void calls.play++,
    pause: () => void calls.pause++,
    spawnSource: (at) => void calls.spawnSource.push(at),
    stopSource: () => void calls.stopSource++,
    clearBend: () => void calls.clearBend++,
    scratchBuffer: () => null, //      no PCM → the resampler wiring is a no-op (null-guarded)
    connectScratch: () => {},
    slipArm: () => void calls.slipArm++,
    slipArmForce: () => void calls.slipArmForce++,
    slipReleasePos: () => s.slip,
  };
  const ctx = { currentTime: 0, state: "running", sampleRate: 48000, resume: () => {} } as unknown as AudioContext;
  return { je: new JogEngine(ctx, host), s, calls };
}

describe("JogEngine — grab vs scrubbing phase boundary (the freeze-fix contract)", () => {
  it("grabbing is the ACTIVE hold; scrubbing also stays true through the release coast", () => {
    const { je } = harness();
    expect(je.grabbing).toBe(false);
    expect(je.scrubbing).toBe(false);
    je.scrubBegin();
    expect(je.grabbing).toBe(true); // finger down
    expect(je.scrubbing).toBe(true);
    je.scrubEnd();
    expect(je.grabbing).toBe(false); // released → coasting
    expect(je.scrubbing).toBe(true); // …but still "scrubbing" until it settles — the trap
  });

  it("a grab hands the deck source to the resampler and parks the playhead", () => {
    const { je, calls } = harness({ start: 10, playing: true });
    je.scrubBegin();
    expect(calls.stopSource).toBe(1);
    expect(calls.setPlaying.at(-1)).toBe(false); // deck source stopped; resampler owns the audio
    expect(calls.clearBend).toBe(1);
  });

  it("a scratch move APPLIES during the grab", () => {
    const { je, s } = harness({ start: 10, playing: true });
    je.scrubBegin();
    je.scrubMove(2);
    expect(s.start).toBe(12); // platter followed the finger
  });

  it("★ THE BUG: a scratch move during the release COAST is SWALLOWED (phase != grab)", () => {
    const { je, s, calls } = harness({ start: 10, playing: true });
    je.scrubBegin();
    je.scrubMove(2); // → 12
    je.scrubEnd(); // now coasting; grabbing == false, scrubbing == true
    const writes = calls.setStartOffset.length;
    je.scrubMove(3); // a fresh scratch arrives mid-coast…
    expect(s.start).toBe(12); // …does nothing — the platter keeps coasting on its own (the freeze)
    expect(calls.setStartOffset.length).toBe(writes);
  });

  it("★ THE FIX: re-grabbing mid-coast interrupts it, and the scratch then applies", () => {
    const { je, s, calls } = harness({ start: 10, playing: true });
    je.scrubBegin();
    je.scrubMove(2); // → 12
    je.scrubEnd(); // coasting
    expect(je.grabbing).toBe(false);
    const stops = calls.stopSource;
    je.scrubBegin(); // the caller re-grabs because finger is still down (useMidiRouting: !deck.grabbing)
    expect(je.grabbing).toBe(true);
    expect(calls.stopSource).toBe(stops); // not re-stopped (source already handed off)
    je.scrubMove(3); // now it lands
    expect(s.start).toBe(15);
  });

  it("a slip-armed release returns straight to the shadow playhead and resumes (no coast)", () => {
    const { je, s, calls } = harness({ start: 10, playing: true, slip: 42 });
    je.scrubBegin();
    je.scrubMove(5);
    je.scrubEnd(); // slipReleasePos != null → snap + resume
    expect(je.scrubbing).toBe(false); // straight to off, no coast
    expect(calls.spawnSource.at(-1)).toBe(42);
    expect(calls.setPlaying.at(-1)).toBe(true);
    expect(s.start).toBe(42);
  });

  it("a scrubMove with no prior grab is inert (off phase)", () => {
    const { je, s } = harness({ start: 10 });
    je.scrubMove(5);
    expect(s.start).toBe(10);
    expect(je.scrubbing).toBe(false);
  });
});
