import { describe, it, expect } from "vitest";
import { JogEngine, servoStep, brakeFriction, decideRelease, type JogHost } from "./JogEngine";

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

function harness(
  over: Partial<{
    start: number;
    playing: boolean;
    loaded: boolean;
    dur: number;
    rate: number;
    slip: number | null;
    loop: { start: number; end: number } | null;
  }> = {},
) {
  const s = {
    start: 10,
    playing: true,
    loaded: true,
    dur: 100,
    rate: 1,
    slip: null as number | null,
    loop: null as { start: number; end: number } | null,
    ...over,
  };
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
    connectScratch: () => {},
    slipArm: () => void calls.slipArm++,
    slipArmForce: () => void calls.slipArmForce++,
    slipReleasePos: () => s.slip,
    loopBounds: () => s.loop,
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

  it("spinback confines the worklet ramp to an active loop, in worklet-local SAMPLES", () => {
    const { je } = harness({ start: 10, playing: true, loop: { start: 8, end: 12 } });
    const sent: { type: string; loopStart?: number; loopEnd?: number }[] = [];
    const port = { onmessage: null as null | ((e: { data: unknown }) => void), postMessage: (d: unknown) => void sent.push(d as { type: string }) };
    je.attachNode({ port } as unknown as AudioWorkletNode);
    je.spinback(0.5);
    const ramp = sent.find((m) => m.type === "ramp")!;
    expect(ramp.loopStart).toBe(8 * 48000);
    expect(ramp.loopEnd).toBe(12 * 48000);
  });

  it("★ REGRESSION: brake ALSO confines to the loop — it always interrupts a PLAYING deck (brakeStop falls back to instant pause() otherwise), so it's still inside the loop when it fires", () => {
    // Was excluded on the (wrong) theory that "a brake settles paused, free to land
    // anywhere" — true in general, but not when the deck was mid-loop when Pause was hit:
    // decelerating without loop bounds could park the platter past the loop's OUT edge,
    // visually and logically outside a loop that's still marked active.
    const { je } = harness({ start: 10, playing: true, loop: { start: 8, end: 12 } });
    je.setVinylSpeed(true, 0.3, 0.2);
    const sent: { type: string; loopStart?: number; loopEnd?: number }[] = [];
    const port = { onmessage: null as null | ((e: { data: unknown }) => void), postMessage: (d: unknown) => void sent.push(d as { type: string }) };
    je.attachNode({ port } as unknown as AudioWorkletNode);
    je.brakeStop();
    const ramp = sent.find((m) => m.type === "ramp")!;
    expect(ramp.loopStart).toBe(8 * 48000);
    expect(ramp.loopEnd).toBe(12 * 48000);
  });

  it("no active loop → the ramp is sent -1,-1 (runs to the track edge, unchanged behaviour)", () => {
    const { je } = harness({ start: 10, playing: true, loop: null });
    const sent: { type: string; loopStart?: number; loopEnd?: number }[] = [];
    const port = { onmessage: null as null | ((e: { data: unknown }) => void), postMessage: (d: unknown) => void sent.push(d as { type: string }) };
    je.attachNode({ port } as unknown as AudioWorkletNode);
    je.spinback(0.5);
    const ramp = sent.find((m) => m.type === "ramp")!;
    expect(ramp.loopStart).toBe(-1);
    expect(ramp.loopEnd).toBe(-1);
  });
});

// The reported bug: "spinback / spin-forward pops out of the loop instead of spinning
// back around" — scrubbing the jog wheel (or coasting off a release) while a loop is
// active must stay confined to the loop's ring, exactly like a physical loop edit on
// vinyl, instead of escaping into the rest of the track.
describe("JogEngine — a live loop confines jog motion (the spinback-escapes-the-loop bug)", () => {
  it("scrubbing forward past the loop's OUT wraps to IN, not past it", () => {
    const { je, s } = harness({ start: 10, playing: true, loop: { start: 8, end: 12 } });
    je.scrubBegin(); // seeds jogPos at position() = 10, inside [8,12)
    je.scrubMove(5); // 10 + 5 = 15 → 3 past OUT(12) → wraps to 8 + 3 = 11
    expect(s.start).toBe(11);
  });

  it("scrubbing backward past the loop's IN wraps to OUT, not before it", () => {
    const { je, s } = harness({ start: 10, playing: true, loop: { start: 8, end: 12 } });
    je.scrubBegin();
    je.scrubMove(-5); // 10 - 5 = 5 → 3 before IN(8) → wraps to 12 - 3 = 9
    expect(s.start).toBe(9);
  });

  it("a paused grab (won't return to play) scrubs freely — the loop only confines while playing", () => {
    const { je, s } = harness({ start: 10, playing: false, loop: { start: 8, end: 12 } });
    je.scrubBegin();
    je.scrubMove(5); // 15, no wrap: nothing is "returning to play" here
    expect(s.start).toBe(15);
  });

  it("no active loop → scrubbing is unconfined (existing full-track behaviour)", () => {
    const { je, s } = harness({ start: 10, playing: true, loop: null });
    je.scrubBegin();
    je.scrubMove(5);
    expect(s.start).toBe(15);
  });
});

// servoStep + brakeFriction — brake and catch-up-to-play are two different physical
// processes (a motor servo vs. hand/pad friction), each anchored to a real, citable number
// (the Technics SL-1200's published 0.7s spin-up spec; felt's measured Fs/Fc≈1.15 tribology
// ratio — AlphaTheta's own patent EP3989600A1 discloses felt as the jog-tension material)
// rather than reverse-engineered from any one product's undisclosed curve. Extracted as pure
// functions for the same reason the state-machine tests above are — CI-locked without an
// AudioContext or rAF.
describe("servoStep — motor servo catch-up-to-play (spin-up, spinback recovery)", () => {
  it("settles near the real Technics SL-1200 spec (~0.7-0.9s to reach target, no overshoot)", () => {
    let state = { v: 0, a: 0 };
    const dt = 0.016;
    const tau = 0.8; // tau=0.8 -> omegaN=8.3, the value this model was actually anchored against
    let settleAt = -1;
    for (let i = 0; i < 100; i++) {
      state = servoStep(state, 1, dt, tau);
      expect(state.v).toBeLessThanOrEqual(1.001); // never overshoots a step target
      if (settleAt < 0 && Math.abs(state.v - 1) < 0.02) settleAt = (i + 1) * dt;
    }
    expect(settleAt).toBeGreaterThan(0.6);
    expect(settleAt).toBeLessThan(1.0);
  });

  it("recovers cleanly from a deeply negative velocity (spinback: thrown backward, caught forward)", () => {
    let state = { v: -2, a: 0 };
    const target = 1;
    for (let i = 0; i < 300; i++) state = servoStep(state, target, 0.01, 0.3);
    expect(state.v).toBeCloseTo(target, 1);
  });

  it("never oscillates past target at the clamped 50ms frame gap", () => {
    let state = { v: 0, a: 0 };
    for (let i = 0; i < 60; i++) {
      state = servoStep(state, 1, 0.05, 0.3);
      expect(state.v).toBeLessThanOrEqual(1.001);
    }
  });

  it("tau<=0 snaps straight to target with zero acceleration", () => {
    expect(servoStep({ v: 5, a: 3 }, 1, 0.016, 0)).toEqual({ v: 1, a: 0 });
  });

  it("★ REGRESSION: a short tau + a clamped 50ms frame gap must not diverge (caught blowing up to 1e19 before sub-stepping was added)", () => {
    // A natural jog release's tau can run as low as 0.025s (lerp(0.025, 0.12, jogWeight)),
    // and dt is clamped to 0.05s on a tab-blur gap — that combination alone (no fault of the
    // caller) pushed the naive explicit-Euler integration well past its stability boundary.
    let state = { v: 0, a: 0 };
    for (let i = 0; i < 40; i++) {
      state = servoStep(state, 1, 0.05, 0.025);
      expect(Number.isFinite(state.v)).toBe(true);
      expect(Math.abs(state.v)).toBeLessThan(10); // nowhere near the ~1e19 the bug produced
    }
    expect(state.v).toBeCloseTo(1, 1);
  });
});

describe("brakeFriction — hand/pad friction braking to a stop", () => {
  it("reaches an EXACT stop in bounded time, unlike an asymptotic exponential", () => {
    let state = { v: 1, z: 0 };
    const dt = 0.005;
    const tau = 0.3;
    let stopAt = -1;
    for (let i = 0; i < 400; i++) {
      state = brakeFriction(state, dt, tau);
      if (stopAt < 0 && state.v === 0) stopAt = (i + 1) * dt;
    }
    expect(stopAt).toBeGreaterThan(0);
    expect(stopAt).toBeLessThan(tau); // finishes decisively inside the old tau, not past it
  });

  it("never overshoots past zero (velocity magnitude only ever shrinks or snaps to exactly 0)", () => {
    let state = { v: 2, z: 0 };
    const dt = 0.05; // the clamped frame gap
    let prevAbs = Math.abs(state.v);
    for (let i = 0; i < 40; i++) {
      state = brakeFriction(state, dt, 0.1);
      expect(Math.abs(state.v)).toBeLessThanOrEqual(prevAbs);
      prevAbs = Math.abs(state.v);
    }
    expect(state.v).toBe(0);
  });

  it("is stable across the full dt/tau/velocity range the deck actually runs at", () => {
    for (const dt of [0.001, 0.016, 0.05]) {
      for (const tau of [0.02, 0.1, 0.3, 0.6]) {
        for (const v0 of [0.05, 0.3, 1, 3]) {
          let state = { v: v0, z: 0 };
          for (let i = 0; i < 200; i++) {
            state = brakeFriction(state, dt, tau);
            expect(Number.isFinite(state.v)).toBe(true);
            expect(Math.abs(state.v)).toBeLessThanOrEqual(Math.max(3, v0) * 1.5);
          }
        }
      }
    }
  });

  it("tau<=0 snaps straight to a stop", () => {
    expect(brakeFriction({ v: 5, z: 2 }, 0.016, 0)).toEqual({ v: 0, z: 0 });
  });
});

// decideRelease — Phase B: the release classification pulled out of scrubEnd() the same way
// sessionFollow.ts pulls decisions out of useSessionSync (pure input struct -> discriminated
// union action, no host/AudioContext needed). Named scenarios, not just coverage — each one
// pins a real branch a caller could otherwise get wrong.
describe("decideRelease — what a lifted finger should do (the scrubEnd() decision)", () => {
  const base = { handVel: 0, jogReturnToPlay: true, slipPos: null as number | null, backSpinTau: 0.4, maxCoast: 3, spinbackFlick: 2.2 };

  it("SLIP armed wins over everything else, even a flick hard enough to look like a spinback", () => {
    const action = decideRelease({ ...base, handVel: -5, slipPos: 42 });
    expect(action).toEqual({ kind: "slip", pos: 42 });
  });

  it("a hard backward flick while playing is a spinback gesture", () => {
    const action = decideRelease({ ...base, handVel: -3, jogReturnToPlay: true });
    expect(action).toEqual({ kind: "spinback", vel: -3, tau: 0.4 });
  });

  it("the SAME hard backward flick while the deck was PAUSED is just a coast, not a spinback", () => {
    // Spinback is a "during playback" gesture (releaseBrake/spawnSource assume it's catching
    // BACK UP to play) — jogReturnToPlay=false must not route through it.
    const action = decideRelease({ ...base, handVel: -3, jogReturnToPlay: false });
    expect(action).toEqual({ kind: "coast", vel: -3 });
  });

  it("a gentle release is a normal coast, not a spinback", () => {
    const action = decideRelease({ ...base, handVel: -0.5, jogReturnToPlay: true });
    expect(action).toEqual({ kind: "coast", vel: -0.5 });
  });

  it("a forward flick is never a spinback, no matter how hard", () => {
    const action = decideRelease({ ...base, handVel: 3, jogReturnToPlay: true });
    expect(action).toEqual({ kind: "coast", vel: 3 });
  });

  it("release velocity is clamped to maxCoast in both directions", () => {
    expect(decideRelease({ ...base, handVel: 50, jogReturnToPlay: false })).toEqual({ kind: "coast", vel: 3 });
    expect(decideRelease({ ...base, handVel: -50, jogReturnToPlay: false })).toEqual({ kind: "coast", vel: -3 });
  });

  it("the spinback threshold is exclusive — exactly at the flick speed is still a plain coast", () => {
    const action = decideRelease({ ...base, handVel: -2.2, jogReturnToPlay: true, spinbackFlick: 2.2 });
    expect(action.kind).toBe("coast");
  });
});
