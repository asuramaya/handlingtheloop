// JOGLAB — browser-side render harness for the jog/scratch/motor-ramp DSP. Vite bundles this
// to an IIFE that joglab.mjs injects into headless Chromium, so it drives the REAL production
// code — JogEngine.ts's own brakeStop()/spinback()/softStart() calls, the REAL scratchWorklet
// running as a genuine AudioWorkletProcessor inside an OfflineAudioContext — not a
// reimplementation. Same philosophy as scripts/fxlab, adapted: an FX device transforms an
// incoming signal; the jog engine has no "input signal" at all — a loaded buffer plus platter
// COMMANDS produce a position trajectory, so what this harness measures is that trajectory,
// not a transfer function.
//
// The one thing worth stating plainly (the fxlab e2cb519e lesson, restated for this domain):
// scratchWorklet.ts hand-duplicates JogEngine.ts's servoStep/brakeFriction math inline in its
// template string ("kept in sync by hand" — the comments say so themselves). A harness that
// only checks "did SOMETHING come out" would happily pass if that hand-port had silently
// drifted from the TS reference. This one recomputes the SAME scenario with the canonical TS
// functions and diffs the two trajectories — the actual point of building it.
//
// ★ RESOLVED — the message-delivery race documented in the git history / htl-joglab-harness
// memory (OfflineAudioContext could invoke a fresh worklet's process() before a postMessage
// sent moments earlier had been marshaled to its realm — confirmed non-deterministic, not a
// code bug) is fixed by NOT racing postMessage against rendering at all. The harness now runs
// a DRY PASS first: it drives the REAL JogEngine (attachNode + brakeNow/spinback/softStart)
// against a recording stand-in for the node, with no OfflineAudioContext render involved, to
// capture the exact message sequence (load/start/ramp) production would send. That sequence is
// then replayed inside the REAL worklet's own constructor via `processorOptions` — delivered
// synchronously, spec-guaranteed complete before the node can ever render (see ScratchJoglab
// below). Same onmessage handler, same message shapes as production; only the transport for
// the harness's t=0 gesture changes from a racy live postMessage to a non-racy constructor arg.
// This does NOT touch production scratchWorklet.ts — the wrapper lives only in this file.

import { JogEngine, servoStep, brakeFriction, type JogHost, type ServoState, type BrakeState } from "../../src/htl/audio/JogEngine";
import { SCRATCH_WORKLET_SRC } from "../../src/htl/audio/scratchWorklet";

// A joglab-only wrapper around the real scratch worklet source: registers a SECOND processor
// ("scratch-joglab") that extends the production `Scratch` class UNMODIFIED and, in its own
// constructor, synchronously replays a captured message sequence handed in via
// `processorOptions` — see the header comment above for why. The original source's own
// `registerProcessor('scratch', Scratch)` still runs too (dead here, harmless — joglab never
// constructs a plain "scratch" node).
//
// Scratch reads PCM live from a registry shared with stretchWorklet.ts (module-scope, inside
// the AudioWorkletGlobalScope — see scratchWorklet.ts's header comment) instead of holding its
// own copy. Each joglabRender() call builds a BRAND NEW OfflineAudioContext, which gets a BRAND
// NEW AudioWorkletGlobalScope — so there is no cross-call registry to reuse (and no main-thread
// globalThis.__htlPcm to seed from out here: that's a different realm entirely). Instead the
// registry entry is seeded from INSIDE the worklet's own constructor, using PCM handed in via
// processorOptions (structured-cloned across the realm boundary, same synchronous-before-any-
// process()-call guarantee as initMessages below) — this stands in for what stretchWorklet.ts's
// loadPcm handler would have published for the SAME deckId in production.
const JOGLAB_WORKLET_SRC = `${SCRATCH_WORKLET_SRC}
class ScratchJoglab extends Scratch {
  constructor(options) {
    super(options);
    const po = (options && options.processorOptions) || {};
    if (po.pcm) globalThis.__htlPcm.set(this.deckId, po.pcm);
    const init = po.initMessages || [];
    for (const data of init) this.port.onmessage({ data });
  }
}
registerProcessor('scratch-joglab', ScratchJoglab);
`;

interface Spec {
  scenario: "brake" | "spinback" | "softStart";
  seconds?: number;
  sampleRate?: number;
  trackDuration?: number; // the fake loaded track's length, seconds
  startPos?: number; // deck position when the gesture fires
  rate?: number; // playback rate at trigger time
  loop?: { start: number; end: number } | null;
  vinylBrakeTime?: number; // 0..1 knob (brake only)
  vinylStartTime?: number; // 0..1 knob (softStart only)
  backSpinLength?: number; // 0..1 knob (spinback only)
  spinbackStrength?: number; // explicit strength override, matches je.spinback(strength)
}

interface PosSample {
  t: number; // audio-domain seconds since render start
  pos: number; // track-seconds
  type: string; // "rampPos" (always exactly `nominal` samples after the previous message) or
  // "rampDone" (fires the instant the settle threshold crosses — NOT nominal-aligned, always
  // the last entry when present). Kept so drift comparison can exclude the one transition whose
  // real elapsed-sample count isn't `nominal` (see joglabRender).
}

interface Report {
  ok: true;
  scenario: string;
  applied: Record<string, number>;
  triggerAt: number; // always 0 — the gesture fires before startRendering(), see the harness note on why
  // The worklet's ACTUAL trajectory, reconstructed from its own rampPos/rampDone reports.
  worklet: { settleAt: number | null; finalPos: number; overshoot: boolean; sampleCount: number };
  // The canonical TS model's trajectory for the SAME scenario, computed independently.
  reference: { settleAt: number | null; finalVel: number };
  // How far the worklet's reported velocity drifted from the TS reference at each sample —
  // the actual "kept in sync by hand" check.
  maxVelDrift: number;
  maxVelDriftAt: number | null;
  loopRespected: boolean | null; // null when no loop was set (n/a)
  // Audio-quality: did real signal actually reach the output (input assertion), and is the
  // render free of discontinuities the source material itself couldn't produce.
  inputRms: number;
  outputRms: number;
  clicks: { tSec: number; step: number; xMedian: number }[];
  note?: string;
}

// Pink noise (Paul Kellet's economy filter — the same one scripts/fxlab and NoiseFx use):
// broadband, non-harsh, and — unlike a pure tone or a silent buffer — gives a click detector
// real per-sample slew to judge discontinuities against everywhere in the render.
function makePinkBuffer(ctx: OfflineAudioContext, seconds: number, sr: number): AudioBuffer {
  const len = Math.max(1, Math.round(seconds * sr));
  const buf = ctx.createBuffer(2, len, sr);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856;
      b4 = 0.55 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.016898;
      d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11 * 3.2;
      b6 = w * 0.115926;
    }
  }
  return buf;
}

function buildHost(state: { pos: number; playing: boolean; duration: number; rate: number; buffer: AudioBuffer; loop: { start: number; end: number } | null }, connectTo: AudioNode): JogHost {
  return {
    position: () => state.pos,
    startOffset: () => state.pos,
    setStartOffset: (v) => { state.pos = v; },
    playing: () => state.playing,
    setPlaying: (v) => { state.playing = v; },
    loaded: () => true,
    duration: () => state.duration,
    rate: () => state.rate,
    effRate: () => state.rate,
    play: () => { state.playing = true; },
    pause: () => { state.playing = false; },
    spawnSource: () => {},
    stopSource: () => {},
    clearBend: () => {},
    scratchBuffer: () => state.buffer,
    scratchWindow: () => Promise.resolve(null),
    connectScratch: (node) => { node.connect(connectTo); },
    slipArm: () => {},
    slipArmForce: () => {},
    slipReleasePos: () => null,
    loopBounds: () => state.loop,
  };
}

// The canonical TS reference for ONE scenario, stepped at the SAME granularity the WORKLET
// actually integrates at (one Euler step per audio sample, dt = 1/sr) — not the ~60Hz UI
// cadence servoStep/brakeFriction are called at elsewhere in JogEngine.ts (grabTick/stepCoast).
// This matters: explicit Euler's truncation error scales with step size, so a 60Hz-stepped
// reference and a 48kHz-stepped worklet will visibly diverge on a fast-changing 2nd-order
// curve EVEN WHEN THE FORMULAS ARE IDENTICAL — that's an artifact of comparing two different
// integration resolutions, not a hand-port bug. Stepping the canonical functions at the same
// dt the worklet uses inline makes this an actual apples-to-apples divergence check.
//
// Also reports POSITION (accumulated the same way the worklet accumulates pos += curStep each
// sample), not just velocity — joglabRender finite-differences BOTH trajectories' positions the
// SAME way to get comparable velocities. Comparing the worklet's finite-differenced (i.e.
// AVERAGE-over-the-report-window) velocity directly against this function's INSTANTANEOUS v
// looked like drift even for an exact hand-port: average-over-an-interval and the value AT one
// endpoint of that interval are different quantities for a fast-changing curve, independent of
// any real implementation difference.
//
// Recorded only every `nominal` samples (the worklet's own rampPos/rampDone reporting cadence)
// so the two trajectories line up sample-for-sample for the diff in joglabRender.
function referenceTrajectory(spec: Required<Pick<Spec, "scenario">> & Spec, sr: number): { t: number; pos: number; vel: number }[] {
  const nominal = Math.round(sr / 60);
  const sampleDt = 1 / sr;
  const target = spec.scenario === "brake" ? 0 : spec.rate ?? 1;
  const tau =
    spec.scenario === "brake" ? 0.02 + (spec.vinylBrakeTime ?? 0.22) * (0.5 - 0.02) :
    spec.scenario === "softStart" ? 0.02 + (spec.vinylStartTime ?? 0.18) * (0.45 - 0.02) :
    0.12 + (spec.backSpinLength ?? 0.5) * (0.6 - 0.12);
  const initialVel = spec.scenario === "brake" ? spec.rate ?? 1 : spec.scenario === "softStart" ? 0 : -(spec.spinbackStrength ?? (4 + (spec.backSpinLength ?? 0.5) * (14 - 4)));
  const isServo = spec.scenario !== "brake";
  let servo: ServoState = { v: initialVel, a: 0 };
  let brake: BrakeState = { v: initialVel, z: 0 };
  let pos = 0; // arbitrary origin — only DELTAS matter, to finite-difference the same way as the worklet
  const out: { t: number; pos: number; vel: number }[] = [{ t: 0, pos: 0, vel: initialVel }];
  const maxSamples = Math.round(2 * sr); // 2s ceiling, matches the old dt-stepped loop's span
  let sinceReport = 0;
  for (let i = 1; i <= maxSamples; i++) {
    if (isServo) servo = servoStep(servo, target, sampleDt, tau);
    else brake = brakeFriction(brake, sampleDt, tau);
    const v = isServo ? servo.v : brake.v;
    pos += v * sampleDt;
    if (++sinceReport < nominal) continue;
    sinceReport = 0;
    out.push({ t: i * sampleDt, pos, vel: v });
    // Matches the worklet's own settle check exactly (scratchWorklet.ts: (curStep-target)^2 < 0.0004).
    const done = Math.abs(v - target) < 0.02;
    if (done) break;
  }
  return out;
}

(globalThis as unknown as { joglabRender: (s: Spec) => Promise<Report> }).joglabRender = async (spec: Spec): Promise<Report> => {
  const sr = spec.sampleRate ?? 48000;
  const seconds = spec.seconds ?? 3;
  const trackDuration = spec.trackDuration ?? 30;
  const rate = spec.rate ?? 1;
  const len = Math.round(seconds * sr);
  const ctx = new OfflineAudioContext(2, len, sr);

  const url = URL.createObjectURL(new Blob([JOGLAB_WORKLET_SRC], { type: "text/javascript" }));
  await ctx.audioWorklet.addModule(url);
  URL.revokeObjectURL(url);

  const buffer = makePinkBuffer(ctx, trackDuration, sr);
  const state = {
    pos: spec.startPos ?? trackDuration / 2,
    playing: spec.scenario === "softStart" ? false : true,
    duration: trackDuration,
    rate,
    buffer,
    loop: spec.loop ?? null,
  };
  const host = buildHost(state, ctx.destination);

  // ---- DRY PASS: drive the REAL JogEngine (attachNode + brakeNow/spinback/softStart)
  // against a recording stand-in for the node — NO OfflineAudioContext render involved — to
  // capture the exact message sequence (load/start/ramp) production would send, in order,
  // with real data. This is what the header comment's fix replays into the real worklet.
  const recorded: unknown[] = [];
  const dryNode = {
    port: {
      postMessage: (data: unknown) => { recorded.push(data); },
      onmessage: null as ((e: MessageEvent) => void) | null,
    },
    connect: () => {},
  } as unknown as AudioWorkletNode;
  // A fake, never-"suspended" ctx-alike: enterMotorCoast()'s `ctx.state === "suspended"` guard
  // would otherwise fire against the real (not-yet-rendering) OfflineAudioContext and try to
  // resume() it before startRendering() — invalid on an offline context, and pointless here
  // since this dry pass never touches real audio rendering at all.
  const fakeCtx = { currentTime: 0, sampleRate: sr, state: "running" } as unknown as AudioContext;
  const je = new JogEngine(fakeCtx, host);
  je.attachNode(dryNode);
  if (spec.vinylBrakeTime != null || spec.vinylStartTime != null) {
    je.setVinylSpeed(true, spec.vinylBrakeTime ?? 0.22, spec.vinylStartTime ?? 0.18);
  } else {
    je.setVinylSpeed(true, 0.22, 0.18);
  }
  if (spec.backSpinLength != null) je.setBackSpinLength(spec.backSpinLength);
  if (spec.scenario === "brake") je.brakeNow(); // fires regardless of the Vinyl Speed toggle, like the Pause button
  else if (spec.scenario === "spinback") je.spinback(spec.spinbackStrength);
  else je.softStart();

  // ---- REAL pass: the actual worklet, seeded via processorOptions instead of live
  // postMessage — see JOGLAB_WORKLET_SRC / ScratchJoglab above. `pcm` stands in for what
  // stretchWorklet.ts's loadPcm handler would have published to the shared registry for
  // this deckId — one group (the pink-noise buffer itself), float32 (pcmScale 1).
  const pcm = { gL: [buffer.getChannelData(0)], gR: [buffer.getChannelData(1)], length: buffer.length, pcmScale: 1 };
  const node = new AudioWorkletNode(ctx, "scratch-joglab", {
    numberOfOutputs: 1,
    outputChannelCount: [2],
    processorOptions: { deckId: "joglab", pcm, initMessages: recorded },
  });
  node.connect(ctx.destination);

  // Reconstruct the worklet's own trajectory from its rampPos/rampDone reports. 'rampPos'
  // fires every `nominal` samples exactly, so index → audio-time is exact for those — but
  // 'rampDone' (always the last message, when present) fires the INSTANT the settle threshold
  // crosses, which is NOT nominal-aligned; its `t` here is still an approximation (see the
  // drift-loop comment below, which excludes the one transition this affects).
  const nominal = Math.round(sr / 60);
  const worklet: PosSample[] = [];
  node.port.onmessage = (e: MessageEvent) => {
    const d = e.data as { type: string; pos: number };
    if (d.type === "rampPos" || d.type === "rampDone") {
      // The FIRST message arrives after `nominal` samples of real elapsed time, not t=0 — index
      // from 1, not 0 (worklet.length is evaluated before the push below).
      worklet.push({ t: (worklet.length + 1) * (nominal / sr), pos: d.pos / sr, type: d.type });
    }
  };

  const rendered = await ctx.startRendering();

  // ---- measure the audio for input-assertion + click detection ----
  const L = rendered.getChannelData(0);
  const R = rendered.numberOfChannels > 1 ? rendered.getChannelData(1) : L;
  const n = L.length;
  let peak = 0, sumSq = 0, inSumSq = 0;
  const srcL = buffer.getChannelData(0);
  for (let i = 0; i < n; i++) {
    const a = Math.abs(L[i]), b = Math.abs(R[i]);
    const m = a > b ? a : b;
    if (m > peak) peak = m;
    sumSq += L[i] * L[i];
    const si = Math.min(srcL.length - 1, i);
    inSumSq += srcL[si] * srcL[si];
  }
  const outputRms = Math.sqrt(sumSq / n);
  const inputRms = Math.sqrt(inSumSq / n);

  const stepAbs = (i: number) => Math.max(Math.abs(L[i] - L[i - 1]), Math.abs(R[i] - R[i - 1]));
  const loud = (i: number) => Math.max(Math.abs(L[i]), Math.abs(R[i])) > peak * 0.02;
  const sampled: number[] = [];
  for (let i = 1; i < n; i += 37) if (loud(i)) sampled.push(stepAbs(i));
  sampled.sort((a, b) => a - b);
  const medianStep = sampled.length ? sampled[Math.floor(sampled.length / 2)] : 0;
  const clicks: { tSec: number; step: number; xMedian: number }[] = [];
  if (medianStep > 0) {
    const cand: { i: number; s: number }[] = [];
    for (let i = 1; i < n; i++) {
      const s = stepAbs(i);
      if (s > medianStep * 4 && s > 1e-4) cand.push({ i, s });
    }
    cand.sort((a, b) => b.s - a.s);
    const guard = Math.round(sr * 0.005);
    for (const c of cand) {
      if (clicks.length >= 6) break;
      if (clicks.some((k) => Math.abs(k.tSec * sr - c.i) < guard)) continue;
      clicks.push({ tSec: c.i / sr, step: c.s, xMedian: c.s / medianStep });
    }
    clicks.sort((a, b) => a.tSec - b.tSec);
  }

  // ---- reference trajectory + drift against the worklet's own reports ----
  const ref = referenceTrajectory(spec as Required<Pick<Spec, "scenario">> & Spec, sr);
  // Both sides report POSITION; finite-difference BOTH the same way to get comparable
  // velocities (diffing the worklet's average-over-the-window velocity against the reference's
  // point-in-time v looked like drift even for an exact hand-port — see referenceTrajectory's
  // comment). Skip the transition INTO a terminal 'rampDone' — it fires the instant the settle
  // threshold crosses, not on the nominal cadence, so `worklet[i].t` for that one entry is an
  // unreliable approximation and would corrupt the finite difference across it.
  let maxVelDrift = 0;
  let maxVelDriftAt: number | null = null;
  for (let i = 1; i < worklet.length; i++) {
    if (worklet[i].type === "rampDone") continue;
    const dtw = worklet[i].t - worklet[i - 1].t;
    if (dtw <= 0) continue;
    const wVel = (worklet[i].pos - worklet[i - 1].pos) / dtw;
    // Nearest reference INDEX by time (need i-1 too, to finite-difference the same way).
    let bi = 0;
    for (let k = 0; k < ref.length; k++) if (Math.abs(ref[k].t - worklet[i].t) < Math.abs(ref[bi].t - worklet[i].t)) bi = k;
    if (bi === 0) continue; // nothing to difference against
    const refVel = (ref[bi].pos - ref[bi - 1].pos) / Math.max(1e-9, ref[bi].t - ref[bi - 1].t);
    const drift = Math.abs(wVel - refVel);
    if (drift > maxVelDrift) { maxVelDrift = drift; maxVelDriftAt = worklet[i].t; }
  }

  const target = spec.scenario === "brake" ? 0 : rate;
  // 'rampDone' fired BECAUSE the worklet's own check found it settled — trust that directly
  // rather than recomputing a velocity across its dt-approximated transition (see above).
  const settledIdx = worklet.findIndex((s, i) => {
    if (i === 0) return false;
    if (s.type === "rampDone") return true;
    return Math.abs((worklet[i].pos - worklet[i - 1].pos) / Math.max(1e-6, worklet[i].t - worklet[i - 1].t) - target) < 0.03;
  });
  const finalPos = worklet.length ? worklet[worklet.length - 1].pos : state.pos;
  const overshoot = spec.scenario !== "brake" && worklet.some((s, i) => {
    if (i === 0 || s.type === "rampDone") return false;
    const v = (worklet[i].pos - worklet[i - 1].pos) / Math.max(1e-6, worklet[i].t - worklet[i - 1].t);
    return target > (spec.rate ?? 1) * -1 ? v > target + 0.05 : v < target - 0.05;
  });

  let loopRespected: boolean | null = null;
  if (state.loop) {
    loopRespected = worklet.every((s) => s.pos >= state.loop!.start - 0.02 && s.pos <= state.loop!.end + 0.02);
  }

  const refSettle = ref.length ? ref[ref.length - 1].t : null;

  return {
    ok: true,
    scenario: spec.scenario,
    applied: { triggerAt: 0, rate, vinylBrakeTime: spec.vinylBrakeTime ?? 0.22, vinylStartTime: spec.vinylStartTime ?? 0.18, backSpinLength: spec.backSpinLength ?? 0.5 },
    triggerAt: 0,
    worklet: { settleAt: settledIdx >= 0 ? worklet[settledIdx].t : null, finalPos, overshoot, sampleCount: worklet.length },
    reference: { settleAt: refSettle, finalVel: ref.length ? ref[ref.length - 1].vel : 0 },
    maxVelDrift,
    maxVelDriftAt,
    loopRespected,
    inputRms,
    outputRms,
    clicks,
    note:
      worklet.length === 0
        ? "NO rampPos/rampDone messages arrived. The processorOptions replay fixed the known delivery race, so this is no longer that — most likely the worklet's 'ramp' branch never actually ran (e.g. a 0-length track/tau) or settled before the first ~60Hz report tick. Check inputRms/outputRms to rule out a silence bug."
        : undefined,
  };
};
