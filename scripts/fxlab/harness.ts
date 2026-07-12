// FXLAB — browser-side render harness. Vite bundles this to an IIFE that fxlab.mjs
// injects into a headless Chromium page, so the REAL FX device code runs in Chromium's
// OfflineAudioContext (the faithful gold-standard render — same DSP as production, not a
// reimplementation). It feeds a chosen test signal through one device, renders offline,
// and reduces the PCM to a COMPACT report (scalars + a downsampled envelope + — for the
// delay — a per-repeat echo ladder) so the driver can print something a text agent can read.
//
// Exposes globalThis.fxlabRender(spec) → Promise<Report>. Heavy reduction happens here
// (the page holds the PCM); only a few hundred numbers cross back to Node.

import { DelayFx } from "../../src/htl/audio/DelayFx";
import { ReverbFx } from "../../src/htl/audio/ReverbFx";
import { SaturatorFx } from "../../src/htl/audio/SaturatorFx";
import { CrushFx } from "../../src/htl/audio/CrushFx";
import { ModFx } from "../../src/htl/audio/ModFx";
import { GateFx } from "../../src/htl/audio/GateFx";
import { NoiseFx } from "../../src/htl/audio/NoiseFx";
import { Eq3 } from "../../src/htl/audio/Eq3";
import { REVERB_WORKLET_SRC } from "../../src/htl/audio/reverbWorklet";
import { CRUSH_WORKLET_SRC } from "../../src/htl/audio/crushWorklet";
import { MOD_DELAY_WORKLET_SRC } from "../../src/htl/audio/modDelayWorklet";
import { factoryFxPresets } from "../../src/htl/audio/fxPresets";
import type { FxDevice, FxKind } from "../../src/htl/audio/Fx";

interface Spec {
  kind: FxKind;
  presetName?: string | null;
  params?: Record<string, number> | null;
  signal?: "impulse" | "burst" | "noise" | "pink" | "tone" | "silence";
  seconds?: number;
  bpm?: number;
  sampleRate?: number;
  toneHz?: number; // probe frequency for signal="tone" (default 1 kHz) — lets a response be sampled point by point
  // A mid-render THROW: slam `throwPreset` in at `throwAt` and restore the previous state at
  // `throwOff` — the FX-pad gesture, rendered. OfflineAudioContext.suspend() is what makes this
  // possible: the render halts at a wall-clock we choose, we mutate the device on the main thread
  // exactly as the pad would, and resume. `stepped` forces the raw setParam path instead of the
  // ramped applyCurve, so the two can be measured against each other.
  throwPreset?: string | null;
  throwAt?: number | null;
  throwOff?: number | null;
  stepped?: boolean;
  // A real PAD THROW (BaseFxDevice.setThrow) at throwAt, released at throwOff — the FX pad itself,
  // not a preset apply. With `startBypassed` the device begins DORMANT exactly as it does in the
  // rack, so the render shows the whole lifecycle: pad wakes it, pad releases, tail rings out, and
  // the device returns to bypass on its own (or doesn't — which is the bug this was built to catch).
  padThrow?: boolean;
  startBypassed?: boolean;
  bypassAt?: number | null; // a MANUAL bypass mid-throw — proves "off means off"
}

type Ctx = OfflineAudioContext;

function buildDevice(ctx: Ctx, kind: FxKind): FxDevice {
  const c = ctx as unknown as AudioContext; // devices type their ctor as AudioContext; Offline is compatible here
  switch (kind) {
    case "delay": return new DelayFx(c);
    case "reverb": return new ReverbFx(c);
    case "saturator": return new SaturatorFx(c);
    case "crush": return new CrushFx(c);
    case "mod": return new ModFx(c);
    case "gate": return new GateFx(c);
    case "noise": return new NoiseFx(c);
    case "eq": return new Eq3(c);
    default: throw new Error(`fxlab: unknown kind ${kind}`);
  }
}

// One test stimulus. Returns a started-able source node feeding the device input.
function makeSignal(ctx: Ctx, signal: string, sr: number, toneHz = 1000): AudioScheduledSourceNode {
  if (signal === "tone") {
    // Steady-state sine (±1) — for gate/mod/eq where the response, not a transient, matters.
    const o = ctx.createOscillator();
    o.type = "sine";
    o.frequency.value = toneHz;
    return o;
  }
  if (signal === "silence") {
    // A muted constant source — feeds nothing, so any output is self-generated (self-oscillation).
    const s = ctx.createConstantSource();
    s.offset.value = 0;
    return s;
  }
  // Buffer-backed stimuli: impulse / burst / noise / pink.
  // PINK is the one to judge LOUDNESS with. White noise is flat per-Hz, so half its energy lives in
  // the top two octaves — under white, killing the bass looks free and killing the highs looks
  // catastrophic, which is the opposite of what happens to music. Pink is equal-energy-per-octave,
  // which is roughly what a mixed track looks like, so a level delta measured against it means
  // something. Pink runs the whole render (a sustained bed), not a 120 ms burst.
  const isPink = signal === "pink";
  const len = Math.round(sr * (signal === "impulse" ? 0.003 : isPink ? 1.0 : 0.12));
  const buf = ctx.createBuffer(2, Math.max(1, len), sr);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    if (signal === "impulse") {
      for (let i = 0; i < d.length; i++) d[i] = 1; // ~3 ms click at full scale
    } else if (isPink) {
      // Paul Kellet's economy pink filter (the same one NoiseFx uses).
      let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
      for (let i = 0; i < d.length; i++) {
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
    } else if (signal === "noise") {
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * 0.7;
    } else {
      // burst — 120 ms of 1 kHz at 0.7 (a "note")
      for (let i = 0; i < d.length; i++) d[i] = Math.sin((2 * Math.PI * 1000 * i) / sr) * 0.7;
    }
  }
  const src = ctx.createBufferSource();
  src.buffer = buf;
  return src;
}

// ---- measurement ---------------------------------------------------------
const dbOf = (lin: number) => (lin <= 1e-9 ? -180 : 20 * Math.log10(lin));

interface Report {
  ok: true;
  kind: string;
  signal: string;
  seconds: number;
  sampleRate: number;
  applied: Record<string, number>;
  peak: number;
  peakDb: number;
  rms: number;
  rmsDb: number;
  clipped: boolean;
  dc: number;
  tailSec: number; // last time |x| stayed above -60 dB of peak
  decayTo60Sec: number; // time from global peak to first drop -60 dB below it (and stay)
  envDb: number[]; // ~120 buckets of bucket-RMS in dB (for an ASCII plot)
  envBuckets: number;
  // delay-only echo ladder (per-repeat peak amplitudes at multiples of the delay time)
  echoes?: { n: number; tSec: number; amp: number; db: number }[];
  effFeedback?: number | null; // median echo[n+1]/echo[n] — the TRUE loop gain
  effFeedbackDbPerRepeat?: number | null;
  growing?: boolean; // any run of ratios > 1 → the tail builds instead of decaying (instability)
  // CLICK detector: the biggest sample-to-sample steps, scored against the median step of the same
  // material. A stepped filter coefficient (or a hard gain change) shows up here as a spike the
  // signal itself could never produce — this is how a "click" looks in numbers.
  clicks?: { tSec: number; step: number; xMedian: number }[];
  medianStep?: number;
  // eq-only: the real magnitude response of the five biquads (Eq3.magnitude), log-spaced.
  responseHz?: number[];
  responseDb?: number[];
  note?: string;
}

// Log-spaced probe frequencies for the EQ response read (20 Hz … 20 kHz).
const RESP_HZ = Array.from({ length: 28 }, (_, i) => Math.round(20 * Math.pow(1000, i / 27)));

function measure(buf: AudioBuffer, meta: { kind: string; signal: string; seconds: number; applied: Record<string, number> }): Report {
  const sr = buf.sampleRate;
  const L = buf.getChannelData(0);
  const R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
  const n = L.length;

  let peak = 0;
  let sumSq = 0;
  let sum = 0;
  let clipped = false;
  for (let i = 0; i < n; i++) {
    const a = Math.abs(L[i]);
    const b = Math.abs(R[i]);
    const m = a > b ? a : b;
    if (m > peak) peak = m;
    if (m > 1.0000001) clipped = true;
    sumSq += L[i] * L[i];
    sum += L[i];
  }
  const rms = Math.sqrt(sumSq / n);
  const dc = sum / n;

  // Envelope buckets (bucket-RMS) for the ASCII plot.
  const B = 120;
  const envDb: number[] = new Array(B);
  const bw = Math.max(1, Math.floor(n / B));
  for (let k = 0; k < B; k++) {
    let ss = 0;
    let cnt = 0;
    const start = k * bw;
    const end = Math.min(n, start + bw);
    for (let i = start; i < end; i++) {
      const v = Math.max(Math.abs(L[i]), Math.abs(R[i]));
      ss += v * v;
      cnt++;
    }
    envDb[k] = dbOf(cnt ? Math.sqrt(ss / cnt) : 0);
  }

  // A coarse short-window RMS envelope (256-sample) for tail/decay + echo picking.
  const win = 256;
  const env = new Float32Array(Math.ceil(n / win));
  for (let k = 0; k < env.length; k++) {
    let ss = 0;
    let cnt = 0;
    const start = k * win;
    const end = Math.min(n, start + win);
    for (let i = start; i < end; i++) {
      const v = Math.max(Math.abs(L[i]), Math.abs(R[i]));
      ss += v * v;
      cnt++;
    }
    env[k] = cnt ? Math.sqrt(ss / cnt) : 0;
  }
  const tSecOf = (envIdx: number) => (envIdx * win) / sr;

  // tail: last window above peak*0.001 (-60 dB).
  const floor = peak * 0.001;
  let tailIdx = 0;
  for (let k = env.length - 1; k >= 0; k--) if (env[k] > floor) { tailIdx = k; break; }
  const tailSec = tSecOf(tailIdx);

  // decay-to-60: from the global-peak window, first window that drops -60 dB and stays.
  let peakIdx = 0;
  for (let k = 0; k < env.length; k++) if (env[k] > env[peakIdx]) peakIdx = k;
  let decayIdx = env.length - 1;
  const dThresh = env[peakIdx] * 0.001;
  for (let k = peakIdx; k < env.length; k++) {
    if (env[k] <= dThresh) {
      let stays = true;
      for (let j = k; j < env.length; j++) if (env[j] > dThresh) { stays = false; break; }
      if (stays) { decayIdx = k; break; }
    }
  }
  const decayTo60Sec = Math.max(0, tSecOf(decayIdx) - tSecOf(peakIdx));

  // CLICK detection. A click is a DISCONTINUITY: one sample-to-sample step far larger than the
  // material's own slew rate. (A 1 kHz sine at 48 k moves ~0.13 × its amplitude per sample; a
  // stepped biquad coefficient can move the output a full scale in one sample.) Score each step
  // against the MEDIAN step of the same render, so the number means "N× what this signal does
  // naturally" and is comparable across stimuli. Report the top few, ≥5 ms apart.
  const stepAbs = (i: number) => Math.max(Math.abs(L[i] - L[i - 1]), Math.abs(R[i] - R[i - 1]));
  const loud = (i: number) => Math.max(Math.abs(L[i]), Math.abs(R[i])) > peak * 0.02;
  // The baseline must come from SOUNDING samples only. Most of a render like "a burst, then its
  // echoes" is silence, and silence has a step of zero — take the median over the whole buffer and
  // it lands on 0, so every honest wiggle of the signal divides by zero and reads as an infinite
  // click. Scoring against the slew of the material where the material actually exists is the only
  // baseline that means anything.
  const sampled: number[] = [];
  for (let i = 1; i < n; i += 37) if (loud(i)) sampled.push(stepAbs(i));
  sampled.sort((a, b) => a - b);
  const medianStep = sampled.length ? sampled[Math.floor(sampled.length / 2)] : 0;
  const clicks: { tSec: number; step: number; xMedian: number }[] = [];
  const guard = Math.round(sr * 0.005); // one click per 5 ms window
  const cand: { i: number; s: number }[] = [];
  if (medianStep > 0) {
    for (let i = 1; i < n; i++) {
      const s = stepAbs(i);
      if (s > medianStep * 4 && s > 1e-4) cand.push({ i, s });
    }
  }
  cand.sort((a, b) => b.s - a.s);
  for (const c of cand) {
    if (clicks.length >= 4) break;
    if (clicks.some((k) => Math.abs(k.tSec * sr - c.i) < guard)) continue;
    clicks.push({ tSec: c.i / sr, step: c.s, xMedian: medianStep > 0 ? c.s / medianStep : 0 });
  }
  clicks.sort((a, b) => a.tSec - b.tSec);

  const report: Report = {
    ok: true,
    kind: meta.kind,
    signal: meta.signal,
    seconds: meta.seconds,
    sampleRate: sr,
    applied: meta.applied,
    peak,
    peakDb: dbOf(peak),
    rms,
    rmsDb: dbOf(rms),
    clipped,
    dc,
    tailSec,
    decayTo60Sec,
    envDb,
    envBuckets: B,
    clicks,
    medianStep,
  };

  // Delay echo ladder: for an impulse, the true per-repeat loop gain is the ratio of
  // successive echo peaks. We know the spacing (the `time` param), so we read the local
  // peak in a window centred on each expected repeat — robust, no peak-picking heuristics.
  if (meta.kind === "delay" && meta.signal === "impulse" && meta.applied.time > 0.005) {
    const dt = meta.applied.time;
    const echoes: { n: number; tSec: number; amp: number; db: number }[] = [];
    const maxN = Math.min(24, Math.floor((meta.seconds - dt) / dt));
    for (let m = 1; m <= maxN; m++) {
      const centre = m * dt;
      const lo = Math.max(0, Math.floor((centre - dt * 0.45) * sr));
      const hi = Math.min(n, Math.floor((centre + dt * 0.45) * sr));
      let amp = 0;
      let at = lo;
      for (let i = lo; i < hi; i++) { const v = Math.max(Math.abs(L[i]), Math.abs(R[i])); if (v > amp) { amp = v; at = i; } }
      echoes.push({ n: m, tSec: at / sr, amp, db: dbOf(amp) });
    }
    report.echoes = echoes;
    // Ratio each repeat against the one before it — but ONLY while there IS a repeat. Once the tail
    // has decayed below the noise floor every later window is silence, and silence/silence poisons
    // the median: a short, low-feedback delay whose tail dies by repeat 5 would read "effective
    // feedback 0.003" out of 24 windows of nothing. Score the LIVE part of the ladder.
    const floorAmp = Math.max(peak * 0.002, 1e-5); // −54 dB of the loudest thing in the render
    const ratios: number[] = [];
    for (let i = 0; i + 1 < echoes.length; i++) {
      if (echoes[i].amp <= floorAmp) break; // the ladder is over — everything past here is silence
      ratios.push(echoes[i + 1].amp / echoes[i].amp);
    }
    if (ratios.length) {
      const sorted = [...ratios].sort((a, b) => a - b);
      const med = sorted[Math.floor(sorted.length / 2)];
      report.effFeedback = med;
      report.effFeedbackDbPerRepeat = dbOf(med);
      // "growing" = 3+ consecutive ratios above 1 (a building tail, not a decaying one).
      let run = 0;
      let grew = false;
      for (const r of ratios) { if (r > 1.001) { run++; if (run >= 3) grew = true; } else run = 0; }
      report.growing = grew;
    } else {
      report.effFeedback = null;
      report.effFeedbackDbPerRepeat = null;
      report.growing = false;
    }
  }

  return report;
}

// ---- entry ---------------------------------------------------------------
// The bank's preset names, so the driver can walk a whole factory bank without duplicating it.
(globalThis as unknown as { fxlabPresetNames: (k: FxKind) => string[] }).fxlabPresetNames = (k: FxKind) => factoryFxPresets(k).map((p) => p.name);

// COVERAGE — what a bank does NOT use. Builds the device, reads its full param surface off a
// reset snapshot, then asks of every param: does any preset move it off the default, and how many
// distinct values does the bank ever ask for? A param that reads `dead` is a feature of the effect
// that no factory preset demonstrates — the bank isn't showing the effect's range, whatever the
// names promise. `flat` = touched, but every preset agrees on one value (a constant, not a choice).
export interface Coverage {
  kind: string;
  presets: number;
  params: { id: string; def: number; distinct: number; min: number; max: number; missing: number; dead: boolean; flat: boolean }[];
}
(globalThis as unknown as { fxlabCoverage: (k: FxKind) => Promise<Coverage> }).fxlabCoverage = async (kind: FxKind) => {
  const ctx = new OfflineAudioContext(2, 128, 48000);
  for (const src of [REVERB_WORKLET_SRC, CRUSH_WORKLET_SRC, MOD_DELAY_WORKLET_SRC]) {
    const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
    await ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
  }
  const dev = buildDevice(ctx, kind);
  dev.reset();
  const defaults = dev.snapshotParams();
  const bank = factoryFxPresets(kind);
  const params = Object.keys(defaults).map((id) => {
    const vals = bank.map((p) => p.params[id]).filter((v) => v != null) as number[];
    const missing = bank.length - vals.length;
    const uniq = new Set(vals.map((v) => Math.round(v * 1e6) / 1e6));
    const def = defaults[id];
    return {
      id,
      def,
      distinct: uniq.size,
      min: vals.length ? Math.min(...vals) : def,
      max: vals.length ? Math.max(...vals) : def,
      missing,
      dead: vals.length > 0 && vals.every((v) => Math.abs(v - def) < 1e-9), // never moved off its default
      flat: uniq.size === 1 && vals.length === bank.length && !vals.every((v) => Math.abs(v - def) < 1e-9),
    };
  });
  return { kind, presets: bank.length, params };
};

(globalThis as unknown as { fxlabRender: (s: Spec) => Promise<Report> }).fxlabRender = async (spec: Spec) => {
  const kind = spec.kind;
  const sr = spec.sampleRate ?? 48000;
  const seconds = spec.seconds ?? 6;
  const signal = spec.signal ?? "impulse";
  const len = Math.round(seconds * sr);
  const ctx = new OfflineAudioContext(2, len, sr);

  // Register the worklet modules used by reverb/crush/mod (best-effort; native devices skip these).
  const modules: [string, string][] = [
    ["reverbfdn", REVERB_WORKLET_SRC],
    ["crush", CRUSH_WORKLET_SRC],
    ["moddelay", MOD_DELAY_WORKLET_SRC],
  ];
  const moduleErrors: string[] = [];
  for (const [name, src] of modules) {
    try {
      const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
      await ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
    } catch (e) {
      moduleErrors.push(`${name}: ${(e as Error).message}`);
    }
  }
  // NEVER let a worklet device render on its fallback. ReverbFx/CrushFx/ModFx catch a missing module
  // in their constructors and degrade to a native path with a console.warn — which means a harness
  // that swallows the addModule failure will confidently report the FALLBACK's numbers as the real
  // DSP. That is worse than no measurement, so it's a hard error here.
  const WORKLET_KINDS: Record<string, boolean> = { reverb: true, crush: true, mod: true };
  if (WORKLET_KINDS[kind] && moduleErrors.length) {
    throw new Error(`fxlab: worklet module(s) failed to load — a ${kind} render would silently be its native fallback, not the real DSP. ${moduleErrors.join("; ")}`);
  }

  const dev = buildDevice(ctx, kind);
  dev.reset();

  // Resolve params: reset defaults → factory preset (if named) → explicit overrides.
  const applied: Record<string, number> = {};
  if (spec.presetName) {
    const p = factoryFxPresets(kind).find((x) => x.name === spec.presetName);
    if (!p) throw new Error(`fxlab: no factory preset "${spec.presetName}" for ${kind}`);
    Object.assign(applied, p.params);
  }
  if (spec.params) Object.assign(applied, spec.params);
  for (const k in applied) dev.setParam(k, applied[k]);
  // Snapshot the device state after applying — but let what we COMMANDED win over the read-back.
  // Ramped params (the delay's `time` rides a setTargetAtTime) still read their OLD value the
  // instant after they're set, and the echo ladder spaces its windows by `time`: trust the
  // read-back and the ladder measures a 0.5 s delay at 0.375 s intervals, i.e. it measures noise.
  const actual = { ...dev.snapshotParams(), ...applied };

  // Mid-render THROW (the FX pad, rendered). suspend() halts the offline render at a chosen time
  // so the device can be driven from the main thread exactly as a pad press would drive it — the
  // only way to measure what a gesture SOUNDS like rather than what a static param set does.
  const quantize = (t: number) => (Math.round((t * sr) / 128) * 128) / sr; // suspend lands on a render quantum
  if (spec.startBypassed) dev.setBypass(true); // a dormant rack resident, as ensurePadFx leaves it
  if (spec.padThrow && spec.throwAt != null) {
    const pad = dev as unknown as { setThrow?: (on: boolean) => void };
    void ctx.suspend(quantize(spec.throwAt)).then(() => {
      pad.setThrow?.(true);
      void ctx.resume();
    });
    if (spec.bypassAt != null) {
      void ctx.suspend(quantize(spec.bypassAt)).then(() => {
        dev.setBypass(true); // the hand on the bypass, mid-throw
        void ctx.resume();
      });
    }
    if (spec.throwOff != null) {
      void ctx.suspend(quantize(spec.throwOff)).then(() => {
        pad.setThrow?.(false);
        void ctx.resume();
      });
    }
  } else if (spec.throwAt != null && spec.throwPreset) {
    const p = factoryFxPresets(kind).find((x) => x.name === spec.throwPreset);
    if (!p) throw new Error(`fxlab: no factory preset "${spec.throwPreset}" for ${kind}`);
    const before = dev.snapshotParams(); // the curve the throw restores on release
    const write = (params: Record<string, number>) => {
      if (dev instanceof Eq3 && !spec.stepped) dev.applyCurve(params); // production path (ramped)
      else for (const k in params) if (k !== "mix") dev.setParam(k, params[k]); // raw step, for the A/B
    };
    void ctx.suspend(quantize(spec.throwAt)).then(() => {
      write(p.params);
      void ctx.resume();
    });
    if (spec.throwOff != null) {
      void ctx.suspend(quantize(spec.throwOff)).then(() => {
        write(before);
        void ctx.resume();
      });
    }
  }

  const source = makeSignal(ctx, signal, sr, spec.toneHz ?? 1000);
  source.connect(dev.input);
  dev.output.connect(ctx.destination);
  source.start(0);

  const rendered = await ctx.startRendering();
  const report = measure(rendered, { kind, signal, seconds, applied: actual });
  // The EQ's response is free (no render needed) and is the whole point of an EQ, so always read
  // it back — this is the curve the preset ACTUALLY produces, not the one its numbers imply.
  if (dev instanceof Eq3) {
    const freqs = new Float32Array(RESP_HZ);
    const out = new Float32Array(RESP_HZ.length);
    dev.magnitude(freqs, out);
    report.responseHz = RESP_HZ;
    report.responseDb = Array.from(out, (v) => Math.round(v * 100) / 100);
  }
  return report;
};
