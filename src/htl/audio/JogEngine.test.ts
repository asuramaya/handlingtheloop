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

// Sustained REVERSE + CENSOR — the #52 logic, locked the same honest way (feel stays the ear-test).
describe("JogEngine — reverse / censor", () => {
  it("reverseStart hands the source to the resampler and arms the slip shadow (REV)", () => {
    const { je, calls } = harness({ start: 10, playing: true });
    je.reverseStart(false);
    expect(je.reversing).toBe(true);
    expect(calls.slipArm).toBe(1); // REV → slip toggle decides
    expect(calls.slipArmForce).toBe(0);
    expect(calls.stopSource).toBe(1);
    expect(calls.setPlaying.at(-1)).toBe(false);
  });

  it("CENSOR force-arms the slip shadow regardless of the toggle", () => {
    const { je, calls } = harness({ start: 10, playing: true });
    je.reverseStart(true); // censor
    expect(calls.slipArmForce).toBe(1);
    expect(calls.slipArm).toBe(0);
  });

  it("reverseStop returns to forward playback at the slip shadow when armed, else the reversed-to pos", () => {
    const a = harness({ start: 10, playing: true, slip: 33 });
    a.je.reverseStart(true);
    a.je.reverseStop();
    expect(a.je.reversing).toBe(false);
    expect(a.calls.spawnSource.at(-1)).toBe(33); // censor snaps back on-beat to the shadow
    expect(a.calls.setPlaying.at(-1)).toBe(true);

    const b = harness({ start: 10, playing: true, slip: null });
    b.je.reverseStart(false);
    b.je.reverseStop();
    expect(b.calls.spawnSource.at(-1)).toBe(10); // no slip → resume where the reverse left off
  });

  it("ignores reverseStart unless playing + loaded, and is not re-entrant", () => {
    const paused = harness({ playing: false });
    paused.je.reverseStart(false);
    expect(paused.je.reversing).toBe(false);
    const unloaded = harness({ loaded: false });
    unloaded.je.reverseStart(false);
    expect(unloaded.je.reversing).toBe(false);
  });
});

// Vinyl-Speed motor ramps (brake / soft-start / spinback). The rAF coast loop doesn't run in node,
// but the ENTRY decisions + the worklet-ramp resume (driven via a fake node's port) are testable.
describe("JogEngine — motor ramps", () => {
  it("falls back to INSTANT transport when Vinyl Speed is off", () => {
    const { je, calls } = harness({ playing: true });
    je.brakeStop();
    expect(calls.pause).toBe(1); // off → straight pause
    const paused = harness({ playing: false });
    paused.je.softStart();
    expect(paused.calls.play).toBe(1); // off → straight play
  });

  it("with Vinyl Speed ON, brake/soft-start enter the worklet MOTOR ramp instead of snapping", () => {
    const brake = harness({ playing: true });
    brake.je.setVinylSpeed(true, 0.3, 0.2);
    brake.je.brakeStop();
    expect(brake.calls.pause).toBe(0); // not an instant pause…
    expect(brake.je.jogging).toBe(true); // …a motor ramp is in flight
    expect(brake.je.ramping).toBe("brake");

    const start = harness({ playing: false });
    start.je.setVinylSpeed(true, 0.3, 0.2);
    start.je.softStart();
    expect(start.je.ramping).toBe("start");
  });

  it("spinback is always available (a gesture) and the worklet's rampDone resumes playback", () => {
    const { je, s, calls } = harness({ start: 10, playing: true });
    const port = { onmessage: null as null | ((e: { data: unknown }) => void), postMessage: () => {} };
    je.attachNode({ port } as unknown as AudioWorkletNode); // capture the worklet message handler
    je.spinback(0.5);
    expect(je.ramping).toBe("spinback");
    expect(je.jogging).toBe(true);
    // The worklet eases the platter backward then catches it — fire its completion at a landed pos.
    port.onmessage!({ data: { type: "rampDone", pos: 42 * 48000 } }); // pos is in samples
    expect(je.jogging).toBe(false); // settled
    expect(calls.spawnSource.at(-1)).toBe(42);
    expect(calls.setPlaying.at(-1)).toBe(true);
    expect(s.start).toBe(42);
  });
});
