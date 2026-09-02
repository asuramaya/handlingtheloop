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
import { CompFx } from "../../src/htl/audio/CompFx";
import { REVERB_WORKLET_SRC } from "../../src/htl/audio/reverbWorklet";
import { CRUSH_WORKLET_SRC } from "../../src/htl/audio/crushWorklet";
import { MOD_DELAY_WORKLET_SRC } from "../../src/htl/audio/modDelayWorklet";
import { COMP_WORKLET_SRC } from "../../src/htl/audio/compWorklet";
import { TAPE_WORKLET_SRC } from "../../src/htl/audio/tapeWorklet";
import { STRETCH_WORKLET_SRC } from "../../src/htl/audio/stretchWorklet";
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
  toneAmp?: number; // tone amplitude (default 1.0) — a saturator's gain is level-DEPENDENT, so the probe level is the experiment
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
    case "comp": return new CompFx(c);
    default: throw new Error(`fxlab: unknown kind ${kind}`);
  }
}

// One test stimulus. Returns a started-able source node feeding the device input.
// A seedable RNG for stimuli that must be REPRODUCIBLE render to render (the MOD audit's level
// checks read PEAKS off a noise bed — with Math.random they drift ±1 dB and a bound flickers).
let stimulusRng: (() => number) | null = null;
export function seedStimulus(seed: number | null) {
  if (seed == null) { stimulusRng = null; return; }
  let a = seed >>> 0;
  stimulusRng = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const rnd = () => (stimulusRng ? stimulusRng() : Math.random());
function makeSignal(ctx: Ctx, signal: string, sr: number, toneHz = 1000, toneAmp = 1): AudioScheduledSourceNode {
  if (signal === "tone") {
    // Steady-state sine (±1) — for gate/mod/eq where the response, not a transient, matters.
    const o = ctx.createOscillator();
    o.type = "sine";
    o.frequency.value = toneHz;
    if (toneAmp === 1) return o;
    const g = ctx.createGain();
    g.gain.value = toneAmp;
    o.connect(g);
    (g as unknown as { start?: () => void }).start = () => o.start();
    return g as unknown as AudioScheduledSourceNode;
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
        const w = rnd() * 2 - 1;
        b0 = 0.99886 * b0 + w * 0.0555179;
        b1 = 0.99332 * b1 + w * 0.0750759;
        b2 = 0.969 * b2 + w * 0.153852;
        b3 = 0.8665 * b3 + w * 0.3104856;
        b4 = 0.55 * b4 + w * 0.5329522;
        b5 = -0.7616 * b5 - w * 0.016898;
        d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
        b6 = w * 0.115926;
      }
      // ★ NORMALISE, because a fixed gain on a random process is a guess. This carried `* 3.2`,
      // which put pink at ~2.4 PEAK — so every render through it tripped the `peak > 1` check and
      // printed "⚠ CLIPPED" no matter what the device did. A whole bank measured that way reads as
      // twenty broken presets and is really one bad stimulus. Scaling to a known peak makes the
      // clip warning mean the DEVICE clipped, which is the only reason to have it.
      // (Found the day fxlab started reporting its own input — see the inputPeak assertion.)
      let pk = 0;
      for (let i = 0; i < d.length; i++) pk = Math.max(pk, Math.abs(d[i]));
      if (pk > 0) {
        const g = 0.7 / pk; // same headroom as the noise/burst stimuli
        for (let i = 0; i < d.length; i++) d[i] *= g;
      }
    } else if (signal === "noise") {
      for (let i = 0; i < d.length; i++) d[i] = (rnd() * 2 - 1) * 0.7;
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
  /** ★ THE INPUT ASSERTION. An estimator with nothing to estimate estimates NOISE, confidently:
   *  a render whose STIMULUS was silent still produces a peak, an RMS, a THD and an echo ladder,
   *  and every one of them is float dust reported to four decimals. The harness measured its
   *  OUTPUT and never once asked whether anything went IN. These carry the answer, and `fxlab`
   *  refuses to print a measurement when `inputOk` is false. */
  inputPeak: number;
  inputRms: number;
  inputOk: boolean;
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
  for (const src of [REVERB_WORKLET_SRC, CRUSH_WORKLET_SRC, MOD_DELAY_WORKLET_SRC, COMP_WORKLET_SRC]) {
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

  // Register the worklet modules used by reverb/crush/mod/comp/saturator-TAPE.
  const modules: [string, string][] = [
    ["reverbfdn", REVERB_WORKLET_SRC],
    ["crush", CRUSH_WORKLET_SRC],
    ["moddelay", MOD_DELAY_WORKLET_SRC],
    ["comp", COMP_WORKLET_SRC],
    ["tape", TAPE_WORKLET_SRC],
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
  // ★ saturator BELONGS here: its TAPE style is a worklet, and 'tape' was missing from the module
  // list entirely — so every TAPE measurement fxlab has ever printed was the NATIVE FALLBACK
  // curve (SaturatorFx warns and degrades), reported as if it were the real DSP. Precisely the
  // failure this guard exists to stop, walked past because the kind wasn't on the list.
  const WORKLET_KINDS: Record<string, boolean> = { reverb: true, crush: true, mod: true, comp: true, saturator: true };
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
  // ★ A device that DEBOUNCES a rebuild on a wall-clock timer (ModFx's STAGES) would otherwise be
  // rendered BEFORE that rebuild lands — an offline render outruns a 120 ms timer — so a
  // `--params '{"stages":12}'` render measured whatever density the constructor built. This is
  // exactly the "harness asserts nothing about its own input" trap: force it before rendering.
  (dev as unknown as { flushRebuild?: () => void }).flushRebuild?.();
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

  const source = makeSignal(ctx, signal, sr, spec.toneHz ?? 1000, spec.toneAmp ?? 1);
  source.connect(dev.input);
  dev.output.connect(ctx.destination);
  source.start(0);

  const rendered = await ctx.startRendering();
  const report = measure(rendered, { kind, signal, seconds, applied: actual });

  // ★ MEASURE THE STIMULUS TOO, in its own context, with the device out of the way. This is the
  // question the harness never asked: did anything actually go IN? A typo'd --signal, a tone-amp
  // of 0, a buffer builder that returned an empty array, a source that was never started — all of
  // them render a perfectly quiet output that every estimator downstream happily characterises.
  // `silence` is the one signal for which quiet is CORRECT, so it is exempt.
  {
    const probe = new OfflineAudioContext(2, len, sr);
    const s2 = makeSignal(probe, signal, sr, spec.toneHz ?? 1000, spec.toneAmp ?? 1);
    s2.connect(probe.destination);
    s2.start(0);
    const inBuf = await probe.startRendering();
    const ch = inBuf.getChannelData(0);
    let pk = 0;
    let sum = 0;
    for (let i = 0; i < ch.length; i++) {
      const v = Math.abs(ch[i]);
      if (v > pk) pk = v;
      sum += ch[i] * ch[i];
    }
    report.inputPeak = Math.round(pk * 1e6) / 1e6;
    report.inputRms = Math.round(Math.sqrt(sum / ch.length) * 1e6) / 1e6;
    // A real stimulus clears -60 dBFS peak comfortably; anything under it is dust, not signal.
    report.inputOk = signal === "silence" || pk > 1e-3;
  }
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

// A CHURN test — the bug class the render harness above CAN'T catch, because it only ever builds
// a device ONE time. "Cranking up the voices crashes" (MOD, 2026-08) was traced to rapid STAGES
// drags on CHORUS/FLANGER firing buildEngine() on every integer step crossed — each rebuild
// creates up to 12 AudioWorkletNodes, a cross-thread, async-message-passing operation, so a fast
// drag fired that a dozen times in under a second. The fix (setStages debounces the rebuild) is
// live regardless of what follows here.
//
// ★ HONEST LIMITATION: this DOES NOT reproduce the crash in headless Chromium, tried BOTH on an
// idle OfflineAudioContext and on a live, continuously-rendering AudioContext with real audio
// actually flowing through the device — same churn pattern, same node counts, both survived
// clean with or without the fix applied. headless Chromium's audio backend (chrome-headless-shell)
// is a stub/null sink, not the real hardware audio pipeline — whatever resource limit or thread
// race the user's real browser hit on real audio hardware, this harness's environment doesn't
// share it. So this is NOT a verified regression test for the reported crash — it's a baseline
// sanity check (no synchronous exception, context doesn't end up "closed"/non-"running") that
// will always have passed even on the buggy code, kept here as scaffolding for whoever next
// touches MOD's rapid-rebuild paths, not as proof this specific bug is caught.
export interface ChurnResult {
  ok: boolean;
  steps: number;
  finalState: string;
  error?: string;
}
(globalThis as unknown as { fxlabChurn: () => Promise<ChurnResult> }).fxlabChurn = async () => {
  const ctx = new AudioContext();
  for (const src of [REVERB_WORKLET_SRC, CRUSH_WORKLET_SRC, MOD_DELAY_WORKLET_SRC, COMP_WORKLET_SRC]) {
    const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
    await ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
  }
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const dev = new ModFx(ctx);
  const noise = ctx.createBufferSource();
  const buf = ctx.createBuffer(2, ctx.sampleRate * 2, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * 0.3;
  }
  noise.buffer = buf;
  noise.loop = true;
  const trim = ctx.createGain();
  trim.gain.value = 0.15; // headless has no real output, but keep it sane regardless
  noise.connect(dev.input);
  dev.output.connect(trim).connect(ctx.destination);
  noise.start();
  let steps = 0;
  try {
    // 2‥12‥2 at ~80fps pointermove pace, once per mode (CHORUS/FLANGER build worklets per voice,
    // BARBER builds oscillator pairs, PHASER's own rebuild was always cheap — covering all four
    // is what makes this a real regression test, not just a re-check of the one mode that crashed).
    for (const mode of [0, 1, 2, 3]) {
      dev.setParam("mode", mode);
      for (const v of [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2]) {
        dev.setParam("stages", v);
        steps++;
        await sleep(12);
      }
      await sleep(250); // let the debounced rebuild actually land before moving to the next mode
    }
    // BARBER's own separate risk: DEPTH + a maxed envelope-driven SOURCE tap can push a voice's
    // delayTime past its DelayNode's ceiling — probe that combination too, since it's a different
    // failure mode (an AudioParam ceiling, not a node-creation storm) that STAGES churn won't hit.
    dev.setParam("mode", 3);
    dev.setParam("depth", 1);
    dev.setParam("src", 2);
    dev.setParam("feedback", 1);
    await sleep(500);
    const finalState = ctx.state;
    dev.dispose();
    noise.stop();
    await ctx.close();
    return { ok: finalState === "running", steps, finalState };
  } catch (e) {
    return { ok: false, steps, finalState: ctx.state, error: (e as Error)?.message || String(e) };
  }
};

// ---- MOD audit ------------------------------------------------------------
// One render per finding of the 2026-08 MOD review, each reduced to a NUMBER with a pass line, so
// "fixed" is a before/after table rather than a claim. Every render here is a 5-channel offline
// context: ch0/1 = device output, ch2/3 = the DRY stimulus itself (the exact same source node),
// ch4 = dev.modSignal. The WET is recovered as out − dryGain·dry (dryGain read from the device when
// it exposes one, else 1 — send-style), so the wet path can be inspected on its own even though
// the device only ever emits the sum. Every render is also scanned for non-finite samples.
export interface ModAuditCheck {
  name: string;
  value: number;
  unit: string;
  pass: boolean;
  detail: string;
}
export interface ModAuditResult {
  ok: boolean;
  checks: ModAuditCheck[];
}

interface ModRender {
  sr: number;
  out: Float32Array; // ch0
  outR: Float32Array; // ch1 — the RIGHT channel, for stereo-width checks
  dry: Float32Array; // ch2
  mod: Float32Array; // ch4
  phase: Float32Array; // ch5 (dev.phaseSignal)
  wet: Float32Array; // out − dryGain·dry
  finite: boolean;
}

let lastRenderMs = 0; // wall time of the most recent renderModAudit render (a CPU-cost proxy)
async function renderModAudit(
  params: Record<string, number>,
  opts: { signal: "noise" | "pink" | "tone"; seconds: number; toneHz?: number; toneAmp?: number; midT?: number; mid?: (dev: ModFx) => void; sampleRate?: number; throwOn?: boolean; after?: (dev: ModFx) => Promise<void> | void; mids?: { t: number; fn: (dev: ModFx) => void }[] },
): Promise<ModRender> {
  const sr = opts.sampleRate ?? 48000;
  const len = Math.round(opts.seconds * sr);
  const ctx = new OfflineAudioContext(6, len, sr);
  const url = URL.createObjectURL(new Blob([MOD_DELAY_WORKLET_SRC], { type: "text/javascript" }));
  await ctx.audioWorklet.addModule(url);
  URL.revokeObjectURL(url);
  const dev = new ModFx(ctx as unknown as AudioContext);
  dev.reset();
  for (const k in params) dev.setParam(k, params[k]);
  // The STAGES rebuild is debounced on a wall-clock timer; an offline render outruns it. Force it.
  (dev as unknown as { flushRebuild?: () => void }).flushRebuild?.();
  if (opts.throwOn) (dev as unknown as { setThrow?: (on: boolean) => void }).setThrow?.(true);
  const merger = ctx.createChannelMerger(6);
  const outSplit = ctx.createChannelSplitter(2);
  dev.output.connect(outSplit);
  outSplit.connect(merger, 0, 0);
  outSplit.connect(merger, 1, 1);
  seedStimulus(20260816); // reproducible beds for the audit (see seedStimulus)
  const source = makeSignal(ctx as unknown as Ctx, opts.signal, sr, opts.toneHz ?? 1000, opts.toneAmp ?? 1);
  seedStimulus(null);
  // makeSignal's "noise" is a 120 ms BURST (a note); the audit wants a sustained bed, so loop it.
  if (source instanceof AudioBufferSourceNode) source.loop = true;
  source.connect(dev.input);
  const drySplit = ctx.createChannelSplitter(2);
  source.connect(drySplit);
  drySplit.connect(merger, 0, 2);
  drySplit.connect(merger, 1, 3);
  try {
    dev.modSignal.connect(merger, 0, 4);
    (dev as unknown as { phaseSignal?: AudioNode }).phaseSignal?.connect(merger, 0, 5);
  } catch {
    /* no tap */
  }
  merger.connect(ctx.destination);
  source.start(0);
  const mids = [...(opts.mids ?? [])];
  if (opts.mid && opts.midT != null) mids.push({ t: opts.midT, fn: opts.mid });
  for (const m of mids) {
    const q = (Math.round((m.t * sr) / 128) * 128) / sr;
    void ctx.suspend(q).then(async () => {
      m.fn(dev);
      (dev as unknown as { flushRebuild?: () => void }).flushRebuild?.();
      // let the worklet thread drain its port queue before the render restarts (see the
      // suspend/resume quirk note above minStepOverRenders)
      await new Promise((r) => setTimeout(r, 40));
      void ctx.resume();
    });
  }
  // ★ Wait for the worklet voices to actually EXIST before rendering. Offline contexts share one
  // worklet thread in Chromium and processor construction is async — ~1 in 6 renders the voices
  // came up AFTER a 1 s render had finished (probe: right params, phi=0, depthS=0: process() never
  // ran) and the "wet" was just the retiring engines' tail. A real-time context brings them up in
  // milliseconds; offline, we have to ask. (_probeVoices resolves on reply or a 500 ms timeout.)
  await (dev as unknown as { _probeVoices?: () => Promise<unknown> })._probeVoices?.();
  const t0 = performance.now();
  const buf = await ctx.startRendering();
  lastRenderMs = performance.now() - t0;
  if (opts.after) await opts.after(dev);
  const out = buf.getChannelData(0);
  const outR = buf.getChannelData(1);
  const dry = buf.getChannelData(2);
  const mod = buf.getChannelData(4);
  const phase = buf.getChannelData(5);
  const dryGain = (dev as unknown as { dryLevel?: number }).dryLevel ?? 1;
  // the device's dry leg may carry a fixed offset (FLANGER THRU): the reference must be shifted
  // by the same amount (fractional, linear interp) before subtracting, or the "wet" is polluted
  const offS = ((dev as unknown as { dryOffsetSec?: number }).dryOffsetSec ?? 0) * sr;
  const dryRef = new Float32Array(out.length);
  for (let i = 0; i < out.length; i++) {
    const p = i - offS;
    const j = Math.floor(p);
    const f = p - j;
    dryRef[i] = j >= 0 && j + 1 < dry.length ? dry[j] * (1 - f) + dry[j + 1] * f : 0;
  }
  const wet = new Float32Array(out.length);
  let finite = true;
  for (let i = 0; i < out.length; i++) {
    wet[i] = out[i] - dryGain * dryRef[i];
    if (!Number.isFinite(out[i]) || !Number.isFinite(mod[i])) finite = false;
  }
  return { sr, out, outR, dry: dryRef, mod, phase, wet, finite };
}

// A plain radix-2 FFT magnitude (power) spectrum, averaged over Hann-windowed frames.
function powerSpectrum(x: Float32Array, n = 4096, from = 0, to = x.length): Float64Array {
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const acc = new Float64Array(n / 2);
  const win = new Float64Array(n);
  for (let i = 0; i < n; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  let frames = 0;
  for (let start = from; start + n <= to; start += n / 2) {
    for (let i = 0; i < n; i++) {
      re[i] = x[start + i] * win[i];
      im[i] = 0;
    }
    // in-place iterative FFT
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const ang = (-2 * Math.PI) / size;
      const wr = Math.cos(ang), wi = Math.sin(ang);
      for (let s = 0; s < n; s += size) {
        let cr = 1, ci = 0;
        for (let k = 0; k < size / 2; k++) {
          const a = s + k, b = s + k + size / 2;
          const tr = re[b] * cr - im[b] * ci;
          const ti = re[b] * ci + im[b] * cr;
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
          const ncr = cr * wr - ci * wi;
          ci = cr * wi + ci * wr;
          cr = ncr;
        }
      }
    }
    for (let i = 0; i < n / 2; i++) acc[i] += re[i] * re[i] + im[i] * im[i];
    frames++;
  }
  if (frames) for (let i = 0; i < n / 2; i++) acc[i] /= frames;
  return acc;
}
function bandPower(ps: Float64Array, sr: number, n: number, lo: number, hi: number): number {
  const b0 = Math.max(0, Math.floor((lo / sr) * n));
  const b1 = Math.min(ps.length - 1, Math.ceil((hi / sr) * n));
  let s = 0;
  for (let i = b0; i <= b1; i++) s += ps[i];
  return s;
}
function rmsOf(x: Float32Array, from: number, to: number): number {
  let s = 0;
  const a = Math.max(0, from), b = Math.min(x.length, to);
  for (let i = a; i < b; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, b - a));
}
function peakOf(x: Float32Array, from = 0, to = x.length): number {
  let p = 0;
  for (let i = Math.max(0, from); i < Math.min(x.length, to); i++) {
    const a = Math.abs(x[i]);
    if (a > p) p = a;
  }
  return p;
}
// Click score: the biggest sample-to-sample step over the median step of the same material.
//
// ★ THE MEDIAN IS TAKEN OVER SOUNDING MATERIAL ONLY. A GATE closes completely at DEPTH 1, so
// half of every cycle is digital silence and the plain median step is exactly 0 — every ratio
// against it came back ~1e8 and read as a catastrophic click when the device was working
// perfectly. Sampling the denominator only where the signal is actually above a floor makes the
// score mean the same thing for a chopped signal as for a continuous one. (The MAX still scans
// everything: a click during a silent passage is still a click, and is in fact the worst kind.)
// The biggest sample-to-sample jump in a window, in absolute terms.
//
// ★ THE LIVE AUDIT JUDGES ON THIS, NOT ON A RATIO. Every ratio needs a denominator that means
// "a typical step of this material", and no such number survives contact with the FX rack: a
// gate's material is silent half the time, a crusher's is a staircase of zero-steps, and a filter
// sweep's material CHANGES WHILE YOU MEASURE IT (the median collapses as the filter smooths the
// signal, so the ratio explodes while nothing clicked). The question a click test actually asks
// is simpler and needs no denominator at all: did this gesture produce a jump BIGGER than the
// material produces on its own, in the state before it and the state after it? A splice does.
// A control that merely changes the sound does not.
function maxAbsStep(x: Float32Array, from: number, to: number): number {
  return maxAbsStepAt(x, from, to).step;
}
// …and WHERE it happened. A click's timing names its cause: at the gesture instant it is the
// parameter write, one fade-length later it is the crossfade's end, one retire-timeout later it
// is the teardown. Guessing between those three costs a rebuild+run each; measuring costs nothing.
function maxAbsStepAt(x: Float32Array, from: number, to: number): { step: number; at: number } {
  const a = Math.max(1, from), b = Math.min(x.length, to);
  let mx = 0;
  let at = a;
  for (let i = a; i < b; i++) {
    const d = Math.abs(x[i] - x[i - 1]);
    if (d > mx) { mx = d; at = i; }
  }
  return { step: mx, at };
}

function maxStepRatio(x: Float32Array, from: number, to: number): number {
  const a = Math.max(1, from), b = Math.min(x.length, to);
  const floor = peakOf(x, a, b) * 1e-3;
  const steps: number[] = [];
  let mx = 0;
  for (let i = a; i < b; i++) {
    const d = Math.abs(x[i] - x[i - 1]);
    if (d > mx) mx = d;
    // ★ …and only NON-ZERO steps. A bit-crusher's sample-and-hold output is a staircase: most
    // consecutive samples are byte-identical, so the plain median step is 0 and every ratio
    // against it reads in the millions — with the device doing exactly what it is for. The
    // typical step of a staircase is the height of one stair, which is what a non-zero median is.
    // (Strided every 16 rather than 64 so a heavily decimated signal still yields enough of them.)
    if ((i & 15) === 0 && d > 0 && (Math.abs(x[i]) > floor || Math.abs(x[i - 1]) > floor)) steps.push(d);
  }
  steps.sort((p, q) => p - q);
  const med = steps[Math.floor(steps.length / 2)] || 1e-9;
  return mx / med;
}

// ★ Chromium quirk: OfflineAudioContext.suspend()/resume() with AudioWorkletNodes in the graph
// intermittently (~50%) makes the worklets' first quantum after resume STALE — the wet phase-
// jumps against the dry and reads as a ×12 step at exactly the suspend instant, even when the
// mid-render callback does nothing at all (verified: fxlabModGestureRepeat with param "__none";
// the worklet-free PHASER never shows it; a live context never suspends). The quirk only ever
// ADDS a spike, while a genuine device click is deterministic — so every suspend-based step
// metric here is the MINIMUM over `n` identical renders (5 for the worklet modes — the quirk
// hits ~30‥50% of renders there, so three in a row is not rare enough).
async function minStepOverRenders(
  n: number,
  params: Record<string, number>,
  opts: Parameters<typeof renderModAudit>[1],
  window: [number, number],
  of: "out" | "wet" = "out",
): Promise<{ step: number; r: ModRender }> {
  let best: { step: number; r: ModRender } | null = null;
  for (let i = 0; i < n; i++) {
    const r = await renderModAudit(params, opts);
    const step = maxStepRatio(r[of], Math.round(window[0] * r.sr), Math.round(window[1] * r.sr));
    if (!best || step < best.step) best = { step, r };
  }
  return best!;
}

(globalThis as unknown as { fxlabModAudit: () => Promise<ModAuditResult> }).fxlabModAudit = async () => {
  const checks: ModAuditCheck[] = [];
  const N = 4096;
  const add = (name: string, value: number, unit: string, pass: boolean, detail: string) => checks.push({ name, value: Math.round(value * 100) / 100, unit, pass, detail });
  const finiteAll: boolean[] = [];

  // 1. CHORUS/FLANGER voice smear — the wet's MID-BAND (300‥3000 Hz) level relative to the dry's,
  //    at 2 vs 12 voices. Same-phase evenly-spread taps form a static FIR comb whose passbands
  //    narrow as the count rises, so the wet's mids collapse; phase-spread voices don't.
  for (const mode of [0, 1]) {
    const name = mode === 0 ? "CHORUS" : "FLANGER";
    const mid: number[] = [];
    for (const stages of [2, 12]) {
      const r = await renderModAudit({ mode, stages, depth: 0.5, feedback: 0, mix: 0.5 }, { signal: "noise", seconds: 4 });
      finiteAll.push(r.finite);
      const pw = powerSpectrum(r.wet, N, r.sr, r.wet.length);
      const pd = powerSpectrum(r.dry, N, r.sr, r.dry.length);
      mid.push(10 * Math.log10(bandPower(pw, r.sr, N, 300, 3000) / bandPower(pd, r.sr, N, 300, 3000)));
    }
    add(`${name.toLowerCase()}-mid-wet@2`, mid[0], "dB re dry", true, `wet mids at 2 voices (mix 0.5)`);
    add(`${name.toLowerCase()}-mid-wet@12`, mid[1], "dB re dry", mid[1] >= mid[0] - 4, `wet mids at 12 voices — must not collapse vs 2 (≥ −4 dB of it)`);
  }

  // 2. BARBER crackle — a 1 kHz tone through a barberpole should come out as slightly pitch-shifted
  //    tones near 1 kHz and nothing else; wet energy above 6 kHz is splice/ringing artefact.
  //    Measured on the WET alone. Three configurations: default WAVE (EASE) with feedback, LINEAR
  //    ramp with feedback, and no feedback at all as the floor.
  for (const [label, p] of [
    ["ease-fb0.5", { mode: 3, wave: 0, feedback: 0.5 }],
    ["linear-fb0.5", { mode: 3, wave: 1, feedback: 0.5 }],
    ["linear-fb0", { mode: 3, wave: 1, feedback: 0 }],
  ] as [string, Record<string, number>][]) {
    const r = await renderModAudit({ ...p, depth: 0.5, rate: 0.6, stages: 6, mix: 0.5 }, { signal: "tone", seconds: 8, toneHz: 1000, toneAmp: 0.5 });
    finiteAll.push(r.finite);
    const from = Math.round(2.5 * r.sr); // skip the start-up bump (checked separately below)
    const pw = powerSpectrum(r.wet, N, from, r.wet.length);
    const hf = 10 * Math.log10(bandPower(pw, r.sr, N, 6000, 20000) / bandPower(pw, r.sr, N, 20, 20000));
    add(`barber-hf-artefact-${label}`, hf, "dB", hf < -45, `wet energy >6 kHz for a 1 kHz tone (splice/ringing) — want < −45 dB`);
    const step = maxStepRatio(r.wet, from, r.wet.length);
    add(`barber-maxstep-${label}`, step, "× median", step < 8, `largest wet sample step / median step — want < 8`);
  }

  // 3. BARBER start-up bump — staggered oscillator start() left not-yet-started lines sitting at
  //    envelope=1, so a pair summed to 2 until the last line began. Wet RMS in the first second vs
  //    settled, at a slow rate (period ≈ 2.4 s).
  {
    const r = await renderModAudit({ mode: 3, wave: 0, feedback: 0, depth: 0.5, rate: 0.4, stages: 6, mix: 0.5 }, { signal: "noise", seconds: 8 });
    finiteAll.push(r.finite);
    const early = rmsOf(r.wet, Math.round(0.1 * r.sr), Math.round(1.1 * r.sr));
    const late = rmsOf(r.wet, Math.round(5 * r.sr), Math.round(8 * r.sr));
    const bump = 20 * Math.log10(early / Math.max(1e-9, late));
    add("barber-start-bump", bump, "dB", Math.abs(bump) < 2, `wet RMS first second vs settled — want |Δ| < 2 dB`);
  }

  // 4. Level — peak of the OUTPUT over the peak of the DRY stimulus, per mode, at the device's own
  //    default mix (0.5) and full mix (1.0). Send-style dry+wet reaches +6 dB at comb peaks; that's
  //    the "pops on the peaks" against a hot program. Want ≤ +1 dB. PINK, not white: makeSignal's
  //    white noise is UNIFORMLY distributed (crest ~1.7), and any dispersive process — an allpass
  //    cascade, a 6-voice sum — turns it Gaussian (crest ~4), so its peaks rise ~2× while its RMS
  //    doesn't move; that reads as +2 dB of "level" that music (already Gaussian-ish) never shows.
  for (const mode of [0, 1, 2, 3]) {
    const name = ["chorus", "flanger", "phaser", "barber"][mode];
    for (const mix of [0.5, 1]) {
      const r = await renderModAudit({ mode, mix, depth: 0.5, feedback: 0.3, stages: 6 }, { signal: "pink", seconds: 4 });
      finiteAll.push(r.finite);
      const g = 20 * Math.log10(peakOf(r.out) / Math.max(1e-9, peakOf(r.dry)));
      // default mix (the deepest-notch point a DJ lives at) must sit under the dry; full wet with
      // regen may peak a touch over it — the check exists to catch the +5‥+9 dB class, and a
      // random pink bed carries ~±1 dB of peak variance render to render.
      const lim = mix === 1 ? 2 : 1;
      add(`level-${name}-mix${mix}`, g, "dB over dry peak", g <= lim, `output peak over the dry stimulus's peak — want ≤ +${lim} dB`);
    }
  }
  // 4b. worst case: 12 voices, full depth, full mix, F.BACK 1
  for (const mode of [0, 1, 2]) {
    const name = ["chorus", "flanger", "phaser"][mode];
    const r = await renderModAudit({ mode, mix: 1, depth: 1, feedback: 1, stages: 12 }, { signal: "pink", seconds: 6 });
    finiteAll.push(r.finite);
    const g = 20 * Math.log10(peakOf(r.out) / Math.max(1e-9, peakOf(r.dry)));
    add(`level-${name}-worst`, g, "dB over dry peak", g <= 4, `12 voices/stages, depth 1, F.BACK 1, mix 1 — want ≤ +4 dB`);
  }

  // 5. The viz tap survives a rebuild — connect dev.modSignal, rebuild STAGES mid-render, and the
  //    tapped signal must still be alive afterwards (a severed tap reads 0 → the viz freezes).
  for (const mode of [0, 1, 2, 3]) {
    const name = ["chorus", "flanger", "phaser", "barber"][mode];
    const r = await renderModAudit({ mode, stages: 6, mix: 0.5, rate: 0.6 }, { signal: "noise", seconds: 4, midT: 1.5, mid: (d) => d.setParam("stages", 9) });
    finiteAll.push(r.finite);
    const before = rmsOf(r.mod, Math.round(0.5 * r.sr), Math.round(1.4 * r.sr));
    const after = rmsOf(r.mod, Math.round(2.0 * r.sr), Math.round(4.0 * r.sr));
    add(`viz-tap-${name}-after-rebuild`, after, "rms", after > 0.05 && before > 0.05, `modSignal RMS after a STAGES rebuild (before: ${before.toFixed(3)}) — want > 0.05`);
    if (mode < 2) {
      // phaseSignal: a 0→1 ramp at the LFO rate — every sample in range, wraps ≈ rate·seconds
      // (counted from 2 s, after the rebuild, so the tap is proven re-linked to the NEW voice 0)
      let inRange = 0, wraps = 0, n = 0;
      for (let i = Math.round(2 * r.sr); i < r.phase.length; i++) {
        n++;
        if (r.phase[i] >= 0 && r.phase[i] <= 1) inRange++;
        if (i > 0 && r.phase[i - 1] - r.phase[i] > 0.5) wraps++;
      }
      const hz = 0.05 * Math.pow(200, 0.6);
      const expect = hz * 2;
      add(`phase-tap-${name}`, wraps, "wraps/2 s", inRange === n && Math.abs(wraps - expect) <= 1, `phaseSignal after the rebuild: in [0,1] ${((inRange / Math.max(1, n)) * 100).toFixed(0)}%, wraps ${wraps} vs ${expect.toFixed(1)} expected at ${hz.toFixed(2)} Hz`);
    }
  }

  // 6. Rebuild click — PHASER on a steady tone, STAGES 6→9 mid-render: the biggest output step
  //    around the swap vs the material's median step. An instant graph teardown is a hard splice.
  {
    const { step, r } = await minStepOverRenders(2, { mode: 2, stages: 6, mix: 0.5, feedback: 0.3 }, { signal: "tone", seconds: 4, toneHz: 1000, toneAmp: 0.5, midT: 2, mid: (d) => d.setParam("stages", 9) }, [1.9, 2.4]);
    finiteAll.push(r.finite);
    add("rebuild-click-phaser", step, "× median", step < 6, `largest output step within ±0.2 s of a STAGES rebuild — want < 6`);
  }

  // ---- round 2: gestures, extremes, robustness --------------------------------------------
  // 7. Gesture continuity — a knob DRAG mid-render on a steady tone: DEPTH 0.2→0.9 (the XY pad
  //    drags this continuously), RATE 0.3→0.8, F.BACK 0.2→0.9. Any un-smoothed parameter is a
  //    splice; the biggest output step within ±0.2 s of the change vs the material's median.
  const gestures: [string, string, number, number][] = [
    ["depth", "depth", 0.2, 0.9],
    ["rate", "rate", 0.3, 0.8],
    ["feedback", "feedback", 0.2, 0.9],
  ];
  for (const mode of [0, 1, 2, 3]) {
    const name = ["chorus", "flanger", "phaser", "barber"][mode];
    for (const [label, param, a, b] of gestures) {
      // worklet modes: LIVE (see renderModLive — offline suspend is invalid there); others: offline
      const { step, r } = mode < 2
        ? await liveGestureStep({ mode, stages: 6, mix: 0.5, [param]: a }, { signal: "tone", seconds: 3, gestures: [{ t: 1.5, fn: (d) => d.setParam(param, b) }] })
        : await minStepOverRenders(1, { mode, stages: 6, mix: 0.5, [param]: a }, { signal: "tone", seconds: 4, toneHz: 1000, toneAmp: 0.5, midT: 2, mid: (d) => d.setParam(param, b) }, [1.9, 2.4]);
      finiteAll.push(r.finite);
      add(`gesture-${name}-${label}`, step, "× median", step < 6, `${label.toUpperCase()} ${a}→${b} mid-render${mode < 2 ? " (live ctx)" : ""} — biggest step vs median, want < 6`);
    }
  }
  // 8. Mode switch continuity + the worklet-instantiation GAP: switching INTO chorus/flanger
  //    creates worklet nodes whose processors come up asynchronously on the render thread —
  //    while the old engine is already fading. Wet RMS in the 150 ms right after the switch vs
  //    settled; a dropout reads as a deep dip.
  for (const [from, to] of [[2, 0], [0, 3], [3, 1], [1, 2]] as [number, number][]) {
    const nm = (m: number) => ["chorus", "flanger", "phaser", "barber"][m];
    const { step, r } = await liveGestureStep({ mode: from, stages: 6, mix: 0.5 }, { signal: "pink", seconds: 4, gestures: [{ t: 2, fn: (d) => d.setParam("mode", to) }] });
    finiteAll.push(r.finite);
    add(`modeswitch-${nm(from)}→${nm(to)}-click`, step, "× median", step < 6, `mode switch mid-render (live ctx) — biggest step vs median, want < 6`);
    const g0 = r.gestureT[0];
    const just = rmsOf(r.wet, Math.round((g0 + 0.05) * r.sr), Math.round((g0 + 0.2) * r.sr));
    const settled = rmsOf(r.wet, Math.round((g0 + 1.0) * r.sr), Math.round((g0 + 1.9) * r.sr));
    const dip = 20 * Math.log10(just / Math.max(1e-9, settled));
    add(`modeswitch-${nm(from)}→${nm(to)}-gap`, dip, "dB", dip > -6, `wet level 50‥200 ms after the switch vs settled (live ctx, real worklet instantiation) — want > −6 dB`);
  }
  // 9. Bypass on/off mid-render (the FLX ON/OFF) — must be a ramp, not a splice.
  {
    const r = await renderModAudit({ mode: 2, stages: 6, mix: 0.5 }, { signal: "tone", seconds: 4, toneHz: 1000, toneAmp: 0.5, midT: 2, mid: (d) => d.setBypass(true) });
    finiteAll.push(r.finite);
    const step = maxStepRatio(r.out, Math.round(1.9 * r.sr), Math.round(2.4 * r.sr));
    add("bypass-click-phaser", step, "× median", step < 6, `setBypass(true) mid-render — biggest step vs median, want < 6`);
    const late = rmsOf(r.wet, Math.round(3 * r.sr), Math.round(4 * r.sr));
    add("bypass-wet-gone", late, "rms", late < 1e-3, `wet RMS 1 s after bypass — want ~0 (and dry back to unity)`);
  }
  // 10. Long-run feedback stability at the WORST regen the UI can reach — F.BACK 1 + a held pad
  //     THROW (fb bump), 20 s of pink: the last 3 s must not be louder than seconds 3‥6.
  for (const mode of [0, 1, 2, 3]) {
    const name = ["chorus", "flanger", "phaser", "barber"][mode];
    const r = await renderModAudit({ mode, stages: 12, mix: 0.5, feedback: 1, depth: 1 }, { signal: "pink", seconds: 20, throwOn: true });
    finiteAll.push(r.finite);
    const early = rmsOf(r.wet, Math.round(3 * r.sr), Math.round(6 * r.sr));
    const late = rmsOf(r.wet, Math.round(17 * r.sr), Math.round(20 * r.sr));
    const growth = 20 * Math.log10(late / Math.max(1e-9, early));
    add(`stability-${name}-throw`, growth, "dB", growth < 1.5, `wet RMS 17‥20 s vs 3‥6 s at F.BACK 1 + throw — want < +1.5 dB (no build-up)`);
  }
  // 11. FLANGER THRU + full depth: the sweep asks for delays BELOW zero (base 0.4 ms, swing
  //     ±2.2 ms) and the worklet clamps at 1 sample — a hard corner in the delay trajectory,
  //     audible as HF splatter on a tone. Same probe as BARBER's artefact check.
  {
    const r = await renderModAudit({ mode: 1, thru: 1, depth: 1, feedback: 0, stages: 2, mix: 0.5 }, { signal: "tone", seconds: 6, toneHz: 1000, toneAmp: 0.5 });
    finiteAll.push(r.finite);
    const from = Math.round(1 * r.sr);
    const pw = powerSpectrum(r.wet, N, from, r.wet.length);
    const hf = 10 * Math.log10(bandPower(pw, r.sr, N, 6000, 20000) / bandPower(pw, r.sr, N, 20, 20000));
    add("flanger-thru-depth1-hf", hf, "dB", hf < -45, `wet >6 kHz for a 1 kHz tone at THRU + full depth — want < −45 dB (no clamp corner)`);
  }
  // 12. 96 kHz: the worklet ring is a fixed 4096 samples — 42 ms at 96 k — while CHORUS at full
  //     depth + throw + BOTH source can ask for ~70 ms; a clamp at the ring's end is a splice.
  {
    const r = await renderModAudit({ mode: 0, depth: 1, feedback: 0, stages: 6, mix: 0.5, src: 2 }, { signal: "tone", seconds: 6, toneHz: 1000, toneAmp: 0.9, sampleRate: 96000, throwOn: true });
    finiteAll.push(r.finite);
    const from = Math.round(1 * r.sr);
    const pw = powerSpectrum(r.wet, N, from, r.wet.length);
    const hf = 10 * Math.log10(bandPower(pw, r.sr, N, 6000, 40000) / bandPower(pw, r.sr, N, 20, 40000));
    add("chorus-96k-both-throw-hf", hf, "dB", hf < -45, `wet >6 kHz for a 1 kHz tone @96 kHz, BOTH+throw+depth 1 — want < −45 dB (ring not clamping)`);
  }
  // 13. Retired engines are actually reaped — after a mid-render rebuild and the render's end,
  //     the device must hold zero retired engines (each holds up to 12 worklet processors).
  {
    let retired = -1;
    await renderModAudit({ mode: 0, stages: 6, mix: 0.5 }, {
      signal: "pink", seconds: 3, midT: 1, mid: (d) => d.setParam("stages", 10),
      after: async (d) => {
        await new Promise((r) => setTimeout(r, 400));
        retired = (d as unknown as { retiredEngines?: number }).retiredEngines ?? -1;
      },
    });
    add("retired-engines-reaped", retired, "count", retired === 0, `retired engines still held 400 ms after the render — want 0`);
  }
  // ---- round 3 --------------------------------------------------------------------------------
  // 15. FLANGER THRU is through-ZERO: with the dry offset in place the wet's relative delay crosses
  //     0, so at the crossing the wet ALIGNS with the dry — zero-lag normalized correlation of the
  //     wet against the dry (10 ms windows, white noise, 2 taps: a mirrored pair crosses together)
  //     must peak near 1. Without THRU the relative delay never gets below ~2.4 ms → ~0.
  {
    const corrMax = (r: ModRender) => {
      const w = Math.round(0.01 * r.sr);
      let best = 0;
      for (let s0 = Math.round(1 * r.sr); s0 + w < r.wet.length; s0 += w >> 1) {
        let sxy = 0, sxx = 0, syy = 0;
        for (let i = s0; i < s0 + w; i++) { sxy += r.wet[i] * r.dry[i]; sxx += r.wet[i] * r.wet[i]; syy += r.dry[i] * r.dry[i]; }
        const c = sxy / Math.sqrt(sxx * syy + 1e-18);
        if (c > best) best = c;
      }
      return best;
    };
    const rt = await renderModAudit({ mode: 1, thru: 1, stages: 2, depth: 1, feedback: 0, mix: 1 }, { signal: "noise", seconds: 4 });
    const rn = await renderModAudit({ mode: 1, thru: 0, stages: 2, depth: 1, feedback: 0, mix: 1 }, { signal: "noise", seconds: 4 });
    finiteAll.push(rt.finite, rn.finite);
    const ct = corrMax(rt), cn = corrMax(rn);
    add("flanger-thru-crossing", ct, "max corr", ct > 0.85, `THRU: peak zero-lag wet/dry correlation — a real through-zero crossing reads ~1 (non-THRU reads ${cn.toFixed(2)})`);
    add("flanger-nothru-no-crossing", cn, "max corr", cn < 0.4, `no THRU: the wet must never align with the dry — want < 0.4`);
  }
  // 15b. THRU toggle mid-render: the dry offset RAMPS in over ~60 ms (a brief pitch dip), never steps.
  {
    const { step, r } = await liveGestureStep({ mode: 1, stages: 6, mix: 0.5, thru: 0 }, { signal: "tone", seconds: 3, gestures: [{ t: 1.5, fn: (d) => d.setParam("thru", 1) }] });
    finiteAll.push(r.finite);
    add("flanger-thru-toggle-click", step, "× median", step < 6, `THRU off→on mid-render (live ctx) — biggest step vs median, want < 6`);
  }
  // 16. Pad THROW on/off mid-render, every mode (live ctx) — engage at 1.5 s, release at 2.5 s.
  for (const mode of [0, 1, 2, 3]) {
    const name = ["chorus", "flanger", "phaser", "barber"][mode];
    const st = (on: boolean) => (d: ModFx) => (d as unknown as { setThrow: (on: boolean) => void }).setThrow(on);
    const { r } = await liveGestureStep({ mode, stages: 6, mix: 0.5 }, { signal: "tone", seconds: 3.5, gestures: [{ t: 1.5, fn: st(true) }, { t: 2.5, fn: st(false) }] });
    finiteAll.push(r.finite);
    const s1 = maxStepRatio(r.out, Math.round((r.gestureT[0] - 0.1) * r.sr), Math.round((r.gestureT[0] + 0.4) * r.sr));
    const s2 = maxStepRatio(r.out, Math.round((r.gestureT[1] - 0.1) * r.sr), Math.round((r.gestureT[1] + 0.4) * r.sr));
    add(`throw-${name}-onoff`, Math.max(s1, s2), "× median", Math.max(s1, s2) < 6, `throw engage (×${s1.toFixed(1)}) / release (×${s2.toFixed(1)}) live — biggest step vs median, want < 6`);
  }
  // 17. ENV/BOTH on a HOT program (tone at 0.9): the follower is scaled ×4, so depth swings can
  //     be several times the LFO's — must stay finite and inside the level bound.
  for (const mode of [0, 1, 2, 3]) {
    const name = ["chorus", "flanger", "phaser", "barber"][mode];
    const r = await renderModAudit({ mode, stages: 6, mix: 0.5, depth: 1, src: 2, feedback: 0.5 }, { signal: "pink", seconds: 6 });
    finiteAll.push(r.finite);
    const g = 20 * Math.log10(peakOf(r.out) / Math.max(1e-9, peakOf(r.dry)));
    add(`env-hot-${name}`, g, "dB over dry peak", g <= 3 && r.finite, `BOTH source, depth 1, F.BACK .5 on a hot pink bed — want ≤ +3 dB and finite`);
  }
  // 18. Boot cost — a device constructed + reset() + a full default param set must build ONE
  //     engine, not three (reset re-sets mode/thru/wave/stages; unchanged values are no-ops).
  {
    let builds = -1;
    await renderModAudit({ mode: 0, stages: 6, mix: 0.5, thru: 0, wave: 0 }, { signal: "pink", seconds: 1, after: (d) => { builds = (d as unknown as { _buildCount: number })._buildCount; } });
    add("boot-build-count", builds, "engines", builds === 1, `engines built through construct + reset() + defaults — want 1`);
  }

  // 14. CPU cost proxy — wall time to render 4 s of audio at STAGES 12, per mode (headless, so
  //     absolute numbers vary by machine; informational unless something is wildly off).
  for (const mode of [0, 1, 2, 3]) {
    const name = ["chorus", "flanger", "phaser", "barber"][mode];
    await renderModAudit({ mode, stages: 12, mix: 0.5, depth: 1 }, { signal: "pink", seconds: 4 });
    const rt = lastRenderMs / 4000;
    add(`cpu-${name}@12`, rt, "× realtime", rt < 0.5, `render-time / audio-time at STAGES 12 (offline, headless) — want < 0.5`);
  }

  add("all-samples-finite", finiteAll.every(Boolean) ? 1 : 0, "bool", finiteAll.every(Boolean), `no NaN/Inf in any audit render (${finiteAll.length} renders)`);
  return { ok: checks.every((c) => c.pass), checks };
};

// One ad-hoc MOD render → the audit's own metrics, for iterating on a single finding without
// re-running the whole table. `--mod-probe '{"mode":3,...}' [--signal tone|noise] [--seconds N]`.
(globalThis as unknown as { fxlabModProbe: (params: Record<string, number>, signal: "noise" | "pink" | "tone", seconds: number) => Promise<Record<string, number>> }).fxlabModProbe = async (params, signal, seconds) => {
  const r = await renderModAudit(params, { signal, seconds, toneHz: 1000, toneAmp: 0.5 });
  const N = 4096;
  const from = Math.round(Math.min(2.5, seconds / 3) * r.sr);
  const pw = powerSpectrum(r.wet, N, from, r.wet.length);
  const pd = powerSpectrum(r.dry, N, from, r.dry.length);
  const tot = bandPower(pw, r.sr, N, 20, 20000);
  return {
    finite: r.finite ? 1 : 0,
    outPeakOverDryDb: 20 * Math.log10(peakOf(r.out) / Math.max(1e-9, peakOf(r.dry))),
    wetPeakOverDryDb: 20 * Math.log10(peakOf(r.wet, from) / Math.max(1e-9, peakOf(r.dry))),
    wetRmsOverDryDb: 20 * Math.log10(rmsOf(r.wet, from, r.wet.length) / Math.max(1e-9, rmsOf(r.dry, from, r.dry.length))),
    wetRmsDb: 20 * Math.log10(rmsOf(r.wet, from, r.wet.length) + 1e-9),
    wetMidsReDryDb: 10 * Math.log10(bandPower(pw, r.sr, N, 300, 3000) / bandPower(pd, r.sr, N, 300, 3000)),
    wetHf6kDb: 10 * Math.log10(bandPower(pw, r.sr, N, 6000, 20000) / tot),
    wetHf3kDb: 10 * Math.log10(bandPower(pw, r.sr, N, 3000, 20000) / tot),
    wetLf500Db: 10 * Math.log10(bandPower(pw, r.sr, N, 20, 500) / tot),
    maxStepRatio: maxStepRatio(r.wet, from, r.wet.length),
  };
};
// Where in the ramp cycle do the wet's spikes land? Histogram of |saw| (ch4 = line A's ramp) at
// every wet step > 8× median — a wrap-splice piles up at |saw|≈1, a mid-sweep fault is uniform.
(globalThis as unknown as { fxlabModSpikes: (params: Record<string, number>) => Promise<{ hist: number[]; n: number; sawAtTop: number[] }> }).fxlabModSpikes = async (params) => {
  const r = await renderModAudit(params, { signal: "tone", seconds: 8, toneHz: 1000, toneAmp: 0.5 });
  const from = Math.round(2.5 * r.sr);
  const steps: number[] = [];
  for (let i = from + 1; i < r.wet.length; i += 64) steps.push(Math.abs(r.wet[i] - r.wet[i - 1]));
  steps.sort((a, b) => a - b);
  const med = steps[Math.floor(steps.length / 2)] || 1e-9;
  const hist = new Array(10).fill(0);
  const top: { d: number; s: number }[] = [];
  for (let i = from + 1; i < r.wet.length; i++) {
    const d = Math.abs(r.wet[i] - r.wet[i - 1]);
    if (d > 8 * med) {
      const s = Math.abs(r.mod[i]);
      hist[Math.min(9, Math.floor(s * 10))]++;
      top.push({ d, s: r.mod[i] });
    }
  }
  top.sort((a, b) => b.d - a.d);
  // a window around the biggest spike: wet + saw, every 4th sample, ±120 samples
  let at = from + 1;
  let best = 0;
  for (let i = from + 1; i < r.wet.length; i++) {
    const d = Math.abs(r.wet[i] - r.wet[i - 1]);
    if (d > best) { best = d; at = i; }
  }
  const win: number[] = [];
  for (let i = at - 120; i <= at + 120; i += 4) win.push(Math.round(r.wet[i] * 1000) / 1000, Math.round(r.mod[i] * 1000) / 1000);
  return { hist, n: top.length, sawAtTop: top.slice(0, 12).map((t) => Math.round(t.s * 1000) / 1000), win, atSec: at / r.sr };
};
(globalThis as unknown as { fxlabModGrowth: (params: Record<string, number>, throwOn: boolean, seconds: number) => Promise<Record<string, number>> }).fxlabModGrowth = async (params, throwOn, seconds) => {
  const r = await renderModAudit(params, { signal: "pink", seconds, throwOn });
  const early = rmsOf(r.wet, Math.round(3 * r.sr), Math.round(6 * r.sr));
  const late = rmsOf(r.wet, Math.round((seconds - 3) * r.sr), Math.round(seconds * r.sr));
  return { growthDb: 20 * Math.log10(late / Math.max(1e-9, early)), earlyDb: 20 * Math.log10(early + 1e-9), lateDb: 20 * Math.log10(late + 1e-9), finite: r.finite ? 1 : 0 };
};
(globalThis as unknown as { fxlabModGesture: (params: Record<string, number>, param: string, to: number, midT?: number) => Promise<Record<string, number>> }).fxlabModGesture = async (params, param, to, midT = 2) => {
  const r = await renderModAudit(params, { signal: "tone", seconds: 4, toneHz: 1000, toneAmp: 0.5, midT, mid: (d) => d.setParam(param, to) });
  const step = maxStepRatio(r.out, Math.round(1.9 * r.sr), Math.round(2.4 * r.sr));
  const stepWet = maxStepRatio(r.wet, Math.round(1.9 * r.sr), Math.round(2.4 * r.sr));
  const stepLater = maxStepRatio(r.out, Math.round(2.6 * r.sr), Math.round(3.9 * r.sr));
  return { step, stepWet, stepLater, finite: r.finite ? 1 : 0 };
};
// Repeat one gesture render N times back-to-back (the audit's own conditions: many contexts in
// one page) and, for the worst one, dump the wet + out around the biggest step + the ctx times of
// every reaper teardown ModFx performed during it.
(globalThis as unknown as { fxlabModGestureRepeat: (params: Record<string, number>, param: string, to: number, n: number) => Promise<unknown> }).fxlabModGestureRepeat = async (params, param, to, n) => {
  const steps: number[] = [];
  let worst: { step: number; at: number; win: number[]; teardowns: number[]; retiredAtSwitch: number } | null = null;
  for (let i = 0; i < n; i++) {
    const teardowns: number[] = [];
    let retiredAtSwitch = -1;
    const r = await renderModAudit(params, {
      signal: "tone", seconds: 4, toneHz: 1000, toneAmp: 0.5, midT: 2,
      mid: (d) => {
        retiredAtSwitch = (d as unknown as { retiredEngines: number }).retiredEngines;
        if (param !== "__none") d.setParam(param, to);
      },
      after: (d) => { teardowns.push(...((d as unknown as { _teardownLog?: number[] })._teardownLog ?? [])); },
    });
    const from = Math.round(1.9 * r.sr), to2 = Math.round(2.4 * r.sr);
    let best = 0, at = from;
    for (let k = from + 1; k < to2; k++) { const dlt = Math.abs(r.out[k] - r.out[k - 1]); if (dlt > best) { best = dlt; at = k; } }
    const step = maxStepRatio(r.out, from, to2);
    steps.push(Math.round(step * 100) / 100);
    if (!worst || step > worst.step) {
      const win: number[] = [];
      for (let k = at - 64; k <= at + 64; k += 4) win.push(Math.round(r.out[k] * 1000) / 1000, Math.round(r.wet[k] * 1000) / 1000);
      const before = rmsOf(r.out, Math.round(1.5 * r.sr), Math.round(1.95 * r.sr));
      const after1 = rmsOf(r.out, Math.round(2.05 * r.sr), Math.round(2.3 * r.sr));
      const after2 = rmsOf(r.out, Math.round(3.0 * r.sr), Math.round(3.9 * r.sr));
      const dryB = rmsOf(r.dry, Math.round(1.5 * r.sr), Math.round(1.95 * r.sr));
      const dryA = rmsOf(r.dry, Math.round(2.05 * r.sr), Math.round(2.3 * r.sr));
      worst = { step, at: at / r.sr, win, teardowns, retiredAtSwitch, before, after1, after2, dryB, dryA } as never;
    }
  }
  return { steps, worst };
};
(globalThis as unknown as { fxlabModThru: (liveFirst?: boolean, warm?: number) => Promise<Record<string, number>> }).fxlabModThru = async (liveFirst = false, warm = 0) => {
  if (liveFirst) await liveGestureStep({ mode: 1, stages: 6, mix: 0.5 }, { signal: "tone", seconds: 1, gestures: [] });
  for (let i = 0; i < warm; i++) await renderModAudit({ mode: i % 4, stages: 6, mix: 0.5 }, { signal: "pink", seconds: 1 });
  const corrMax = (r: ModRender) => {
    const w = Math.round(0.01 * r.sr);
    let best = 0;
    for (let s0 = Math.round(1 * r.sr); s0 + w < r.wet.length; s0 += w >> 1) {
      let sxy = 0, sxx = 0, syy = 0;
      for (let i = s0; i < s0 + w; i++) { sxy += r.wet[i] * r.dry[i]; sxx += r.wet[i] * r.wet[i]; syy += r.dry[i] * r.dry[i]; }
      const c = sxy / Math.sqrt(sxx * syy + 1e-18);
      if (c > best) best = c;
    }
    return best;
  };
  let dt = -1, off = -1, mode = -1, thru = -1, builds = -1;
  const reps: string[] = [];
  const corrByTime = (r: ModRender) => {
    const w = Math.round(0.01 * r.sr);
    const buckets: number[] = [];
    for (let b = 0; b < 16; b++) {
      let best = 0;
      for (let s0 = Math.round(b * 0.25 * r.sr); s0 + w < Math.round((b + 1) * 0.25 * r.sr); s0 += w >> 1) {
        let sxy = 0, sxx = 0, syy = 0;
        for (let i = s0; i < s0 + w; i++) { sxy += r.wet[i] * r.dry[i]; sxx += r.wet[i] * r.wet[i]; syy += r.dry[i] * r.dry[i]; }
        best = Math.max(best, sxy / Math.sqrt(sxx * syy + 1e-18));
      }
      buckets.push(Math.round(best * 100) / 100);
    }
    return buckets;
  };
  for (let i = 0; i < 8; i++) {
    let info = "";
    const rr = await renderModAudit({ mode: 1, thru: 1, stages: 2, depth: 1, feedback: 0, mix: 1 }, { signal: "noise", seconds: 4, after: async (d) => {
      const x = d as unknown as { dryDelay: DelayNode; _probeVoices: () => Promise<Record<string, number>[]>; retiredEngines: number };
      const v = await x._probeVoices();
      info = `dryDelay=${x.dryDelay.delayTime.value.toFixed(5)} retired=${x.retiredEngines} voices=${JSON.stringify(v.map((q) => ({ b: Math.round(q.base), d: Math.round(q.depth), dS: Math.round(q.depthS), hz: q.lfoHz, ph: q.phase, on: q.lfoOn, phi: Math.round((q.phi ?? 0) * 100) / 100, t: q.timeout })))}`;
    } });
    reps.push(`${corrMax(rr).toFixed(2)} [${corrByTime(rr).slice(0, 9).join(" ")}] ${info}`);
  }
  (globalThis as unknown as { __thruReps: string[] }).__thruReps = reps;
  const rt = await renderModAudit({ mode: 1, thru: 1, stages: 2, depth: 1, feedback: 0, mix: 1 }, { signal: "noise", seconds: 4, after: (d) => {
    const x = d as unknown as { dryDelay: DelayNode; dryOffsetSec: number; _buildCount: number };
    dt = x.dryDelay.delayTime.value; off = x.dryOffsetSec; mode = d.getParam("mode"); thru = d.getParam("thru"); builds = x._buildCount;
  } });
  const rn = await renderModAudit({ mode: 1, thru: 0, stages: 2, depth: 1, feedback: 0, mix: 1 }, { signal: "noise", seconds: 4 });
  return { thru: corrMax(rt), nothru: corrMax(rn), dryDelayValue: dt, dryOffsetSec: off, mode, thruParam: thru, builds, reps: reps as unknown as number };
};
// Bare Chromium test: a 1 kHz tone through ONE moddelay worklet (static 1-sample delay, no
// device) in an OfflineAudioContext, suspend+resume at 2 s doing nothing — how big is the step?
(globalThis as unknown as { fxlabSuspendQuirk: (n: number, withWorklet: boolean, settleMs: number) => Promise<number[]> }).fxlabSuspendQuirk = async (n, withWorklet, settleMs) => {
  const out: number[] = [];
  for (let k = 0; k < n; k++) {
    const sr = 48000;
    const ctx = new OfflineAudioContext(1, 4 * sr, sr);
    const url = URL.createObjectURL(new Blob([MOD_DELAY_WORKLET_SRC], { type: "text/javascript" }));
    await ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    const o = ctx.createOscillator();
    o.frequency.value = 1000;
    let last: AudioNode = o;
    if (withWorklet) {
      const w = new AudioWorkletNode(ctx, "moddelay", { numberOfInputs: 2, numberOfOutputs: 1, outputChannelCount: [1] });
      w.port.postMessage({ base: 1, depth: 0, fb: 0, lfoOn: 0 });
      o.connect(w, 0, 0);
      last = w;
    }
    last.connect(ctx.destination);
    o.start(0);
    void ctx.suspend(2).then(async () => {
      if (settleMs) await new Promise((r) => setTimeout(r, settleMs));
      void ctx.resume();
    });
    const buf = await ctx.startRendering();
    const x = buf.getChannelData(0);
    out.push(Math.round(maxStepRatio(x, Math.round(1.9 * sr), Math.round(2.4 * sr)) * 100) / 100);
  }
  return out;
};

// ---- GATE beat alignment ----------------------------------------------------------------------
// Does the gate actually LAND ON THE BEAT, and does it walk there instead of jumping? The pure
// cycle-length decision has unit tests; this drives the real device, with a real grid, and reads
// the answer off the rendered audio — where the gate's closed windows actually fall.
//
// A deliberately WRONG starting phase is the point: the device is handed a grid whose bar line
// sits a third of a cycle away from where its free-running phase would have been, and the report
// shows the error per cycle. Converging to ~0 without any single cycle jumping is the behaviour;
// landing at 0 immediately would mean it snapped, which is the click we refused to ship.
(globalThis as unknown as { fxlabGateAlign: (aligned?: boolean) => Promise<{ cycleErr: number[]; period: number; sr: number; peak: number; env: number[]; dbg: Record<string, number> }> }).fxlabGateAlign = async (aligned = true) => {
  const sr = 48000;
  const seconds = 6;
  const ctx = new OfflineAudioContext(1, Math.round(seconds * sr), sr);
  const dev = new GateFx(ctx as unknown as AudioContext);
  dev.reset();
  dev.setBypass(false, true);
  dev.setParam("mix", 1);
  dev.setParam("depth", 1); // fully closed windows → unambiguous edges to find
  dev.setParam("duty", 0.5);
  dev.setParam("smooth", 0);
  dev.setParam("shape", 0); // SQUARE
  dev.setParam("sync", 0); // a FREE rate, so the period is a known constant here
  dev.setParam("rate", 0.5);
  dev.setParam("align", aligned ? 1 : 0);
  const period = 1 / dev.freqHz;
  // The bar line: deliberately offset from where the gate's own phase started.
  const barAt = 0.31 * period;
  dev.setGrid({ at: barAt, bar: period * 4, beatsPerBar: 4 });
  const src = ctx.createBufferSource();
  const buf = ctx.createBuffer(1, Math.round(seconds * sr), sr);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.sin((2 * Math.PI * 400 * i) / sr) * 0.5;
  src.buffer = buf;
  src.connect(dev.input);
  dev.output.connect(ctx.destination);
  src.start(0);
  const out = (await ctx.startRendering()).getChannelData(0);
  // Envelope → the instants the gate OPENS (a rising crossing of half the running peak).
  const win = Math.round(sr * 0.002);
  const env = new Float32Array(Math.floor(out.length / win));
  for (let k = 0; k < env.length; k++) {
    let p = 0;
    for (let i = k * win; i < (k + 1) * win; i++) p = Math.max(p, Math.abs(out[i]));
    env[k] = p;
  }
  // The open level is taken from the STEADY STATE, not the whole render: the device's start-up
  // (dry and wet both passing while the insert's crossfade settles) peaks ~3× higher, and using
  // that as the reference put the threshold above every real gate opening — the probe then found
  // no edges at all and looked exactly like a gate that wasn't gating.
  const skip = Math.round(1.5 / (win / sr));
  let hi = 0;
  for (let k = skip; k < env.length; k++) hi = Math.max(hi, env[k]);
  const opens: number[] = [];
  for (let k = skip + 1; k < env.length; k++) {
    if (env[k - 1] < hi * 0.5 && env[k] >= hi * 0.5) opens.push((k * win) / sr);
  }
  // Each opening's distance from the nearest grid slot, in cycles, signed, shortest way round.
  const cycleErr = opens.map((t) => {
    let e = (t - barAt) % period;
    if (e < 0) e += period;
    if (e > period / 2) e -= period;
    return Math.round((e / period) * 1000) / 1000;
  });
  const dbg = { depth: dev.getParam("depth"), duty: dev.getParam("duty"), shape: dev.getParam("shape"), align: dev.getParam("align"), mix: dev.getParam("mix"), byp: dev.bypassed ? 1 : 0, hz: dev.freqHz, openAt025: dev.gateShape(0.25), closedAt075: dev.gateShape(0.75) };
  return { dbg, cycleErr, period, sr, peak: Math.round(hi * 1000) / 1000, env: Array.from(env.slice(0, 40)).map((v) => Math.round(v * 100) / 100) };
};

// ---- NOISE audit ------------------------------------------------------------------------------
// Seven behaviours were added to the riser at once, and "it sounds right" is the operator's call —
// but most of the CLAIMS underneath are numbers, and a claim that can be a number should be one
// before anybody is asked to listen.
//
// ★ THE TRICK THAT MAKES THIS MEASURABLE. The device is a GENERATOR: its own broadband noise sits
// on top of everything, which is what defeated the first attempt (measuring the DUCK's envelope on
// a tone, drowned by the noise on top of it). The way through is not a better time-domain
// detector, it's a NARROWBAND one — a Goertzel at exactly the probe tone's frequency. Noise
// spreads its energy across the spectrum, so in a single bin the tone stands well clear of it, and
// the tone's amplitude over time IS the duck curve, cleanly.
function goertzel(x: Float32Array, from: number, n: number, hz: number, sr: number): number {
  const k = 2 * Math.cos((2 * Math.PI * hz) / sr);
  let s1 = 0;
  let s2 = 0;
  const to = Math.min(x.length, from + n);
  for (let i = from; i < to; i++) {
    const s0 = x[i] + k * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  const m = Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - k * s1 * s2));
  return (2 * m) / Math.max(1, to - from);
}

/** The probe tone's amplitude over time, in blocks — i.e. whatever gain the DRY leg is under. */
function toneEnvelope(x: Float32Array, sr: number, hz: number, blockSec = 0.02): { env: Float32Array; block: number } {
  const block = Math.round(sr * blockSec);
  const n = Math.floor(x.length / block);
  const env = new Float32Array(n);
  for (let i = 0; i < n; i++) env[i] = goertzel(x, i * block, block, hz, sr);
  return { env, block };
}

/** Spectral centroid (Hz) of one slice — how HIGH the noise layer is sitting right now. */
function centroid(x: Float32Array, from: number, n: number, sr: number): number {
  const N = 4096;
  const ps = powerSpectrum(x, N, from, Math.min(x.length, from + n));
  let num = 0;
  let den = 0;
  for (let b = 1; b < ps.length; b++) {
    const f = (b * sr) / N;
    if (f < 40 || f > 18000) continue;
    num += f * ps[b];
    den += ps[b];
  }
  return den > 0 ? num / den : 0;
}

interface NoiseRender {
  sr: number;
  L: Float32Array;
  R: Float32Array;
}
async function renderNoise(
  params: Record<string, number>,
  opts: { seconds: number; throwAt: number; throwOff?: number; toneHz?: number; bpm?: number; grid?: { at: number; bar: number } | null; keyHz?: number },
): Promise<NoiseRender> {
  const sr = 48000;
  const ctx = new OfflineAudioContext(2, Math.round(opts.seconds * sr), sr);
  const dev = new NoiseFx(ctx as unknown as AudioContext);
  dev.reset();
  dev.setBypass(false, true);
  for (const k in params) dev.setParam(k, params[k]);
  dev.setSyncBpm(opts.bpm ?? 120);
  if (opts.grid !== undefined) dev.setGrid(opts.grid);
  if (opts.keyHz) dev.setKeyHz(opts.keyHz);
  if (opts.toneHz) {
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = opts.toneHz;
    const g = ctx.createGain();
    g.gain.value = 0.5;
    osc.connect(g).connect(dev.input);
    osc.start(0);
  }
  dev.output.connect(ctx.destination);
  const q = (t: number) => Math.round((t * sr) / 128) * (128 / sr);
  // NOT awaited: suspend(t) resolves only when the render REACHES t, so awaiting before
  // startRendering() deadlocks.
  void ctx.suspend(q(opts.throwAt)).then(() => {
    (dev as unknown as { setThrow: (on: boolean) => void }).setThrow(true);
    void ctx.resume();
  });
  if (opts.throwOff != null) {
    void ctx.suspend(q(opts.throwOff)).then(() => {
      (dev as unknown as { setThrow: (on: boolean) => void }).setThrow(false);
      void ctx.resume();
    });
  }
  const buf = await ctx.startRendering();
  return { sr, L: buf.getChannelData(0), R: buf.getChannelData(1) };
}

(globalThis as unknown as { fxlabNoiseAudit: () => Promise<ModAuditResult> }).fxlabNoiseAudit = async () => {
  const checks: ModAuditCheck[] = [];
  const add = (name: string, value: number, unit: string, pass: boolean, detail: string) =>
    checks.push({ name, value: Math.round(value * 1000) / 1000, unit, pass, detail });
  const bpm = 120;
  const barSec = (60 / bpm) * 4; // 2 s
  const TONE = 5000; // the probe tone — parked where the riser has no energy (see below)

  // 1. SNAP — does the build END on a bar line, however ragged the press?
  //    Read through DUCK: the dry tone is pulled down along the build curve and flat afterwards,
  //    so the last fall in its narrowband envelope is the build's end, exactly.
  // ★ The probe tone sits at 5 kHz with the device's post-LP wound down to 600 Hz, so the riser
  // has almost no energy in the bin being read. The device is a generator and its wet CANNOT be
  // silenced during a throw (BaseFxDevice.throwMix floors it), so the only way to read the duck
  // cleanly is to put the probe somewhere the noise isn't. A first attempt read a 1 kHz bin with
  // the LP wide open and the noise sat right on top of it: the answer came back ~0.4 bars late
  // with ±0.1 of jitter, which is what a detector tracking noise looks like.
  const endErr = async (snap: boolean) => {
    const errs: number[] = [];
    for (const press of [0, 0.17, 0.4, 0.73, 0.95]) {
      const at = (1 + press) * barSec;
      const r = await renderNoise(
        { rise: 1, bars: 2, snap: snap ? 1 : 0, duck: 1, impact: 0, mix: 0.5, tone: 0 },
        { seconds: 12, throwAt: at, toneHz: TONE, bpm, grid: { at: 0, bar: barSec } },
      );
      const { env, block } = toneEnvelope(r.L, r.sr, TONE);
      // ★ The end is where the duck ARRIVES at its floor, not where it last "stepped down". A
      // per-block difference test cannot see a slow ramp at all: 0.4 of amplitude spread over
      // 200 blocks moves ~0.002 per block, under any tolerance loose enough to ignore noise — so
      // the detector fired zero times and silently reported the PRESS time as the end, which
      // looked exactly like SNAP doing nothing. Arrival is unambiguous and needs no tolerance on
      // the slope at all.
      const k0 = Math.floor((at * r.sr) / block);
      let hi = 0;
      let lo = Infinity;
      for (let k = k0; k < env.length; k++) {
        hi = Math.max(hi, env[k]);
        lo = Math.min(lo, env[k]);
      }
      const arrive = lo + (hi - lo) * 0.02;
      let endK = env.length - 1;
      for (let k = k0; k < env.length; k++) if (env[k] <= arrive) { endK = k; break; }
      const bars = ((endK * block) / r.sr) / barSec;
      errs.push(bars - Math.round(bars));
    }
    return errs;
  };
  const onErrs = await endErr(true);
  const offErrs = await endErr(false);
  const onWorst = Math.max(...onErrs.map(Math.abs));
  const offSpread = Math.max(...offErrs) - Math.min(...offErrs);
  add("snap-lands-on-bar", onWorst, "bars off", onWorst < 0.08, `worst |error| over 5 ragged press times: ${onErrs.map((e) => e.toFixed(3)).join(" ")}`);
  add("snap-off-scatters", offSpread, "bars spread", offSpread > 0.25, `SNAP off must NOT land — proves the check can tell the difference: ${offErrs.map((e) => e.toFixed(3)).join(" ")}`);

  // 2. DIR — the sweep's direction, read as the noise layer's spectral centroid early vs late.
  // ★ Read the LOW-BAND FRACTION, not the spectral centroid. The centroid of a broadband noise
  // layer is dominated by where the post-LP sits and barely twitches as the high-pass climbs
  // (measured: 6257 → 7903 Hz, a real move in the right direction but a feeble signal). What the
  // sweep actually does is empty out the bottom, and that is enormous: near-everything below
  // 500 Hz at the start of an UP build, near-nothing at the end.
  const lowFrac = (x: Float32Array, at: number, sr: number) => {
    const ps = powerSpectrum(x, 4096, Math.round(at * sr), Math.round(at * sr) + 4096);
    const lo = bandPower(ps, sr, 4096, 60, 500);
    const all = bandPower(ps, sr, 4096, 60, 18000);
    return all > 0 ? lo / all : 0;
  };
  for (const dir of [0, 1]) {
    const r = await renderNoise({ rise: 1, bars: 2, dir, snap: 0, mix: 1, duck: 0, impact: 0 }, { seconds: 8, throwAt: 1, bpm });
    const early = lowFrac(r.L, 1.4, r.sr);
    const late = lowFrac(r.L, 4.6, r.sr);
    const up = dir === 0;
    const pass = up ? late < early * 0.5 : late > early * 2;
    add(up ? "dir-up-empties-the-bottom" : "dir-down-refills-it", late / Math.max(1e-9, early), "late/early low-band", pass, `${up ? "UP: the sweep climbs away from the bottom" : "DOWN: it comes back down into it"} — ${(early * 100).toFixed(1)}% → ${(late * 100).toFixed(1)}% of energy under 500 Hz`);
  }

  // 3. CURVE — the build's shape, read at its MIDPOINT. Late bloom is still low there; a
  //    front-loaded build is already most of the way up. Measured on the duck (deterministic).
  const midOf = async (curve: number) => {
    const at = 1;
    const r = await renderNoise({ rise: 1, bars: 2, curve, snap: 0, duck: 1, impact: 0, mix: 0.5 }, { seconds: 10, throwAt: at, toneHz: TONE, bpm });
    const { env, block } = toneEnvelope(r.L, r.sr, TONE);
    const kAt = (t: number) => Math.floor((t * r.sr) / block);
    const base = env[kAt(at - 0.2)] || 1;
    const floor = env[kAt(at + 2 * barSec + 0.3)] || 0;
    const mid = env[kAt(at + barSec)] || 0;
    return (base - mid) / Math.max(1e-6, base - floor); // 0 = nothing yet, 1 = fully arrived
  };
  const late = await midOf(0);
  const lin = await midOf(0.5);
  const early = await midOf(1);
  add("curve-late-holds-back", late, "progress at 50%", late < 0.4, `CURVE 0 must still be low at the halfway point (linear reads ${lin.toFixed(2)})`);
  add("curve-early-leaps", early, "progress at 50%", early > 0.6, `CURVE 1 must already be high at the halfway point`);
  add("curve-linear-is-linear", Math.abs(lin - 0.5), "|error| vs 0.5", Math.abs(lin - 0.5) < 0.12, `the centre detent must actually be linear: ${lin.toFixed(3)}`);

  // 4. TONAL follows the KEY — the pitched layer must START on the tonic, not on 80 Hz.
  // ★ A DIFFERENTIAL, across two different keys. Comparing "energy at the root" against "energy a
  // semitone away" inside the same render cannot work: the riser's noise fills both bins equally
  // and the tonal layer is deliberately quiet (gain 0.16), so the ratio sits at ~1 whether the
  // feature works or not — it did, and read 0.94. Rendering the SAME device twice with different
  // tonics and asking whether each root is louder in its OWN render cancels the noise floor,
  // because the noise is identical in distribution both times.
  const rootA = 16.3516 * Math.pow(2, 9 / 12) * 4; // A2 ≈ 110 Hz
  const rootC = 16.3516 * Math.pow(2, 0 / 12) * 5; // C3 ≈ 131 Hz
  {
    // ★ Measured at the build's MIDPOINT, not at its start. The level envelope swells from ~0, so
    // in the first tenth of a build the whole wet — tonal layer included — is at half a percent of
    // amplitude, and a first attempt that probed there was reading noise with a straight face. By
    // the midpoint the layer is properly present, and the frequency there is a known function of
    // the root (the curve is linear at the centre detent, so it is root × 16^0.5 = root × 4).
    // Eight bars rather than four halves the sweep rate, so the tone smears across fewer bins.
    const p = { rise: 1, bars: 8, type: 2, snap: 0, mix: 1, duck: 0, impact: 0, res: 0, tone: 1 };
    const rA = await renderNoise(p, { seconds: 20, throwAt: 1, bpm, keyHz: rootA });
    const rC = await renderNoise(p, { seconds: 20, throwAt: 1, bpm, keyHz: rootC });
    // ★ Measured EARLY, and here is why the midpoint is the wrong place: the tonal oscillator and
    // the sweep high-pass climb together, and the HP climbs FASTER — by the halfway point it sits
    // near 980 Hz while the fundamental is at root×4 ≈ 440, so the device has filtered out its own
    // fundamental and the comb has nothing left to compare. Early in the build the fundamental is
    // still above the corner (120 Hz against 93 Hz).
    //
    // Probing early costs nothing in SNR, which is the part that looks wrong and isn't: the level
    // envelope is at ~3% there, but it scales the tonal layer and the noise bed by the SAME
    // amount, and this is a ratio test. The envelope cancels.
    const from = Math.round(1.02 * rA.sr);
    const n = Math.round(0.5 * rA.sr);
    // The tonal layer is a SAWTOOTH, so it puts energy at f, 2f, 3f… — five bins of evidence
    // instead of one. And the comparison is WITHIN a render (this root's comb vs the other
    // root's comb in the same audio), because the noise buffer is freshly random per render:
    // comparing one bin ACROSS two renders measures the noise's variance, not the feature, and
    // duly reported the answer backwards.
    // A sawtooth puts energy at f, 2f, 3f… so four harmonics are four pieces of evidence; each is
    // smeared across the little span the oscillator sweeps through during the window, so each is
    // summed over that span rather than read at a single point.
    const comb = (x: Float32Array, sr: number, f0: number) => {
      let sum = 0;
      for (let h = 1; h <= 4; h++) for (let i = 0; i <= 5; i++) sum += goertzel(x, from, n, f0 * h * (1 + 0.018 * i), sr);
      return sum;
    };
    const lift = Math.min(comb(rA.L, rA.sr, rootA) / Math.max(1e-9, comb(rA.L, rA.sr, rootC)), comb(rC.L, rC.sr, rootC) / Math.max(1e-9, comb(rC.L, rC.sr, rootA)));
    add("tonal-follows-key", lift, "× the other key\u0027s comb", lift > 1.3, `in each render, the harmonic comb on THAT key must beat the comb on the other one`);
  }

  // 5. DUCK — does the track actually come down, by the amount claimed, and back up after?
  for (const duck of [0, 0.5, 1]) {
    const at = 1;
    const r = await renderNoise({ rise: 1, bars: 2, duck, snap: 0, impact: 0, mix: 0.5 }, { seconds: 10, throwAt: at, throwOff: at + 2 * barSec + 0.2, toneHz: TONE, bpm });
    const { env, block } = toneEnvelope(r.L, r.sr, TONE);
    const kAt = (t: number) => Math.floor((t * r.sr) / block);
    const base = env[kAt(at - 0.2)] || 1;
    const bottom = env[kAt(at + 2 * barSec)] || 0;
    const after = env[kAt(at + 2 * barSec + 1.2)] || 0;
    const got = 1 - bottom / Math.max(1e-9, base);
    const want = duck * 0.8;
    add(`duck-depth@${duck}`, got, "fraction pulled down", Math.abs(got - want) < 0.08, `want ${want.toFixed(2)} of the dry removed at full build`);
    if (duck > 0) add(`duck-releases@${duck}`, after / Math.max(1e-9, base), "× original", after / Math.max(1e-9, base) > 0.9, "the music must come straight back up on release");
  }

  // 6. IMPACT — present when asked, silent when not, and never past 0 dBFS at its own maximum.
  {
    const off = 5; // let the 2-bar build COMPLETE before releasing — the loudest case
    const peaks: Record<string, { hit: number; full: number }> = {};
    for (const [tag, mix] of [["wet", 1], ["rest", 0.5]] as const) {
      for (const impact of [0, 1]) {
        const r = await renderNoise({ rise: 1, bars: 2, impact, snap: 0, duck: 0, mix, width: 1 }, { seconds: 9, throwAt: 1, throwOff: off, bpm });
        // ★ Read the impact in the LOW BAND. A completed UP build has its high-pass at 12 kHz, so
        // the riser has no bottom end at all — while the impact's whole lower half is a sine
        // falling 80 → 32 Hz. Time-domain peak cannot separate them (the riser's own release from
        // a full build is still at 0.76 five milliseconds after the cut, and by the time that has
        // decayed the impact has too); the spectrum separates them completely.
        const ps = powerSpectrum(r.L, 8192, Math.round((off + 0.005) * r.sr), Math.round((off + 0.3) * r.sr));
        const hit = bandPower(ps, r.sr, 8192, 30, 120);
        let full = 0;
        for (let i = 0; i < r.L.length; i++) full = Math.max(full, Math.abs(r.L[i]));
        peaks[`${tag}${impact}`] = { hit, full };
      }
    }
    const sub = peaks.wet1.hit / Math.max(1e-12, peaks.wet0.hit);
    add("impact-fires", sub, "× low band vs no impact", sub > 20, "IMPACT must land a real sub on the drop — a finished riser has no bottom end of its own");
    // ★ Judged as a RATIO, not an absolute. A full-wet riser at maximum resonance plus a maximum
    // impact exceeding 0 dBFS is true of most devices at their extremes and is what the master
    // limiter is for; the useful question is whether IMPACT is a hit or a level bomb. The
    // absolute check lives where it means something — the device's own resting mix.
    const lift = peaks.wet1.full / Math.max(1e-9, peaks.wet0.full);
    add("impact-is-a-hit-not-a-bomb", lift, "× the riser alone", lift < 2.5, `full-wet peak ${peaks.wet0.full.toFixed(2)} → ${peaks.wet1.full.toFixed(2)}`);
    add("impact-clean-at-rest-mix", peaks.rest1.full, "peak at mix 0.5", peaks.rest1.full < 1, "at the device's own default wet, a maximum IMPACT must not clip on its own");
  }

  // 7. WIDTH — decorrelation, and what a mono sum costs. Silence in, so this is the noise alone.
  for (const width of [0, 1]) {
    const r = await renderNoise({ rise: 0, width, snap: 0, duck: 0, impact: 0, mix: 1 }, { seconds: 4, throwAt: 0.5, bpm });
    const from = Math.round(1.5 * r.sr);
    let num = 0;
    let dl = 0;
    let dr = 0;
    let sm = 0;
    for (let i = from; i < r.L.length; i++) {
      num += r.L[i] * r.R[i];
      dl += r.L[i] * r.L[i];
      dr += r.R[i] * r.R[i];
      const m = 0.5 * (r.L[i] + r.R[i]);
      sm += m * m;
    }
    const corr = num / Math.max(1e-12, Math.sqrt(dl * dr));
    const monoDb = 20 * Math.log10(Math.sqrt(sm / Math.max(1e-12, dl)));
    if (width === 0) add("width-0-is-mono-safe", corr, "L/R correlation", corr > 0.99, "the default must be bit-identical channels — no mono cost at all");
    else {
      add("width-1-decorrelates", corr, "L/R correlation", Math.abs(corr) < 0.2, "full width must be genuinely independent noise per side");
      add("width-1-mono-cost", monoDb, "dB, mono vs L", monoDb > -4.5, "…and the mono sum must still hold up (uncorrelated: −3 dB is the theoretical floor)");
    }
  }

  return { ok: checks.every((c) => c.pass), checks };
};

// ---- MOD stereo width -------------------------------------------------------------------------
// WIDTH gives each channel its own LFO phase, which is what opens the image — and what a MONO
// SUM cancels, because the two channels' combs interleave. The panel and the device both claim
// that trade in their comments, so it gets measured rather than asserted: L/R correlation (1 =
// identical, lower = wider) and the mono sum's RMS against the left channel's (how much of the
// effect survives a summed PA, in dB).
(globalThis as unknown as { fxlabModWidth: (widths: number[]) => Promise<{ width: number; corr: number; monoVsLeftDb: number }[]> }).fxlabModWidth = async (widths) => {
  const out: { width: number; corr: number; monoVsLeftDb: number }[] = [];
  for (const width of widths) {
    // ★ A MONO source, on purpose. The pink bed generates INDEPENDENT noise per channel, so L and
    // R are already uncorrelated before the device touches them and a width metric reads the
    // stimulus instead of the effect (measured: identical −0.03 correlation at every width). A
    // tone is identical in both channels, so any decorrelation downstream is the device's doing.
    const r = await renderModAudit({ mode: 0, stages: 6, depth: 0.7, rate: 0.4, mix: 1, width }, { signal: "tone", seconds: 3, toneHz: 700, toneAmp: 0.5 });
    // renderModAudit hands back ch0/ch1 of the device output as out/dry pairs; re-render straight
    // through fxlabRender would lose the stereo, so read the raw buffer here instead.
    const L = r.out;
    const R = r.outR;
    const from = Math.round(0.5 * r.sr);
    let num = 0, dl = 0, dr = 0, sm = 0, sl = 0;
    for (let i = from; i < L.length; i++) {
      num += L[i] * R[i];
      dl += L[i] * L[i];
      dr += R[i] * R[i];
      const m = 0.5 * (L[i] + R[i]);
      sm += m * m;
      sl += L[i] * L[i];
    }
    const corr = num / Math.max(1e-12, Math.sqrt(dl * dr));
    const monoVsLeftDb = 20 * Math.log10(Math.sqrt(sm / Math.max(1e-12, sl)));
    out.push({ width, corr: Math.round(corr * 1000) / 1000, monoVsLeftDb: Math.round(monoVsLeftDb * 100) / 100 });
  }
  return out;
};

// ---- WaveShaper oversampling latency --------------------------------------------------------
// ★ Why this exists: the saturator's four static styles run through a WaveShaper with
// `oversample: "4x"`, and TAPE runs through a worklet instead. Oversampling means up-sampling
// FIR filters, and an FIR has GROUP DELAY — so the two engines may not be time-aligned, which
// would make a style swap a jump between two alignments (measured: ×2.7 the material, only ever
// on TAPE↔shaper swaps) and, worse, would leave a TAPE band permanently offset against its two
// neighbours in the sum, which combs. This measures the delay instead of assuming it: an impulse
// through an IDENTITY 4x WaveShaper against the same impulse direct, peak index vs peak index.
(globalThis as unknown as { fxlabShaperLatency: (sr?: number) => Promise<{ direct: number; shaped: number; lagSamples: number; sr: number; energyBefore: number }> }).fxlabShaperLatency = async (sr = 48000) => {
  const ctx = new OfflineAudioContext(2, Math.round(sr * 0.05), sr);
  const buf = ctx.createBuffer(1, 256, sr);
  buf.getChannelData(0)[32] = 1;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const ws = ctx.createWaveShaper();
  const c = new Float32Array(4097);
  for (let i = 0; i < c.length; i++) c[i] = (i / (c.length - 1)) * 2 - 1; // identity: latency only
  ws.curve = c;
  ws.oversample = "4x";
  const merger = ctx.createChannelMerger(2);
  src.connect(ws).connect(merger, 0, 0);
  src.connect(merger, 0, 1);
  merger.connect(ctx.destination);
  src.start(0);
  const r = await ctx.startRendering();
  const a = r.getChannelData(0); // through the shaper
  const b = r.getChannelData(1); // direct
  const peak = (x: Float32Array) => {
    let bi = 0, bv = 0;
    for (let i = 0; i < x.length; i++) { const v = Math.abs(x[i]); if (v > bv) { bv = v; bi = i; } }
    return bi;
  };
  const shaped = peak(a);
  const direct = peak(b);
  // How much of the shaped impulse arrives BEFORE the direct one — a linear-phase FIR smears both
  // ways, so the peak alone under-reports what a swap actually hears.
  let energyBefore = 0;
  for (let i = 0; i < direct; i++) energyBefore += a[i] * a[i];
  return { direct, shaped, lagSamples: shaped - direct, sr, energyBefore };
};

// ---- LIVE (real-time AudioContext) gesture renders ------------------------------------------
// ★ Chromium drops/duplicates an AudioWorklet quantum across OfflineAudioContext.suspend()/resume()
// — a bare passthrough worklet + a do-nothing suspend at 2 s reads a ×12.2 step 100% of the time
// (fxlabSuspendQuirk), never without the worklet. So mid-render GESTURES on the worklet modes
// (CHORUS/FLANGER) can't be measured offline at all. This runs the device on a real-time
// AudioContext (headless Chromium's null sink still clocks it), fires gestures on the wall clock
// exactly as the app does, and records the device output + the dry reference with a tiny recorder
// worklet — the same ModRender shape, so every metric above applies unchanged.
const REC_WORKLET_SRC = `
class FxlabRec extends AudioWorkletProcessor {
  constructor() { super(); this.a = []; this.b = []; this.start = -1; this.on = true;
    this.port.onmessage = (e) => { if (e.data.stop) { this.on = false;
      const n = this.a.length * 128; const A = new Float32Array(n), B = new Float32Array(n);
      for (let i = 0; i < this.a.length; i++) { A.set(this.a[i], i * 128); B.set(this.b[i], i * 128); }
      this.port.postMessage({ a: A, b: B, start: this.start }, [A.buffer, B.buffer]); } }; }
  process(inputs) { if (!this.on) return false; if (this.start < 0) this.start = currentFrame;
    const x = inputs[0] && inputs[0][0], y = inputs[1] && inputs[1][0];
    this.a.push(x ? Float32Array.from(x) : new Float32Array(128)); this.b.push(y ? Float32Array.from(y) : new Float32Array(128)); return true; }
}
registerProcessor('fxlabrec', FxlabRec);`;
let liveCtx: AudioContext | null = null;
async function liveContext(): Promise<AudioContext> {
  if (liveCtx) return liveCtx;
  const ctx = new AudioContext();
  // EVERY worklet the rack owns, not just MOD's: the suspend quirk is a property of the offline
  // context, so reverb / crush / comp / the saturator's TAPE style are all equally unmeasurable
  // there and all need this same live path.
  for (const src of [MOD_DELAY_WORKLET_SRC, REVERB_WORKLET_SRC, CRUSH_WORKLET_SRC, COMP_WORKLET_SRC, TAPE_WORKLET_SRC, STRETCH_WORKLET_SRC, REC_WORKLET_SRC]) {
    const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
    await ctx.audioWorklet.addModule(url); // no try/catch on purpose: a missing module here means
    // the device under test silently becomes its native fallback, which is worse than no number
    URL.revokeObjectURL(url);
  }
  await ctx.resume();
  liveCtx = ctx;
  return ctx;
}

// ---- GENERIC live gesture render (any device) ------------------------------------------------
// The MOD-specific renderModLive below keeps its dry-reference arithmetic (thru-zero needs a
// fractionally-delayed dry); this one is the plain version every other device wants: run the real
// device on the wall clock, poke it exactly as a pointer would, and score the OUTPUT for a splice.
//
// ★ A DRAG IS NOT A SET. `ms` turns a gesture into a ~60 Hz stream of setParam calls from `from`
// to `to` — which is what a finger on a knob actually emits, and it is a different experiment: a
// device can be click-free on a single jump and still splice on every frame of a drag (that is
// exactly how MOD's DEPTH bug read: x12‥16 the median step, one splice per frame).
export interface LiveGesture {
  t: number; // seconds from render start
  param: string; // "__none" = fire nothing (the control: proves the RIG is quiet)
  to: number;
  from?: number; // set (with ms) to sweep instead of jump
  ms?: number; // drag duration; omit for an instant set
}
interface LiveRender {
  sr: number;
  out: Float32Array;
  finite: boolean;
  windows: [number, number][]; // one measurement window per gesture, in SECONDS from start
  // ★ AND ONE SETTLED WINDOW PER GESTURE — a quiet stretch AFTER the tail, with the gesture's
  // new state in force and nobody touching anything.
  //
  // Without it the metric cannot tell "this gesture spliced" from "this gesture changed the
  // material". Real case: dragging the saturator's crossover reads ×42, and so does the device
  // sitting perfectly still afterwards — moving the split point pushed more content into a
  // hot-driven band, which squares it off, and steppier material scores higher forever. Judging
  // the gesture against the material it REPLACED convicts every control that legitimately makes
  // a signal sharper.
  settled: [number, number][];
}
async function renderLive(
  kind: FxKind,
  params: Record<string, number>,
  opts: { signal: "tone" | "pink" | "noise"; seconds: number; toneHz?: number; toneAmp?: number; gestures: LiveGesture[]; startBypassed?: boolean },
): Promise<LiveRender> {
  const ctx = await liveContext();
  const sr = ctx.sampleRate;
  const dev = buildDevice(ctx as unknown as Ctx, kind);
  dev.reset();
  for (const k in params) dev.setParam(k, params[k]);
  dev.setBypass(!!opts.startBypassed, true);
  (dev as unknown as { flushRebuild?: () => void }).flushRebuild?.();
  const rec = new AudioWorkletNode(ctx, "fxlabrec", { numberOfInputs: 2, numberOfOutputs: 1, outputChannelCount: [1] });
  const source = makeSignal(ctx as unknown as Ctx, opts.signal, sr, opts.toneHz ?? 1000, opts.toneAmp ?? 0.5);
  if (source instanceof AudioBufferSourceNode) source.loop = true;
  source.connect(dev.input);
  dev.output.connect(rec, 0, 0);
  source.connect(rec, 0, 1);
  const sink = ctx.createGain();
  sink.gain.value = 0;
  rec.connect(sink).connect(ctx.destination);
  const t0 = ctx.currentTime + 0.05;
  source.start(t0);
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const windows: [number, number][] = [];
  const settled: [number, number][] = [];
  let elapsed = 0;
  for (const g of [...opts.gestures].sort((a, b) => a.t - b.t)) {
    await sleep(Math.max(0, (g.t - elapsed) * 1000));
    const started = ctx.currentTime - t0;
    if (g.param === "__none") {
      // nothing — the control run
    } else if (g.ms && g.from != null) {
      const frames = Math.max(1, Math.round(g.ms / 16));
      for (let i = 1; i <= frames; i++) {
        dev.setParam(g.param, g.from + ((g.to - g.from) * i) / frames);
        await sleep(16);
      }
    } else {
      dev.setParam(g.param, g.to);
    }
    const ended = ctx.currentTime - t0;
    elapsed = g.t + Math.max(0, ended - started);
    // ★ The window opens AT the gesture, not before it. It used to start 50 ms early "to be
    // safe", and that pre-roll contains the PREVIOUS state's material — so a control moving from
    // steppy to smooth (a saturator leaving TAPE) was charged for the steps of the state it was
    // leaving, judged against the smooth state it arrived at. A parameter write cannot cause a
    // step before it happens; there is nothing to be safe about.
    windows.push([started, ended + 0.35]); // the gesture, plus the tail a splice rings into
    settled.push([ended + 0.45, ended + 0.85]); // …then the new steady state, untouched
  }
  await sleep(Math.max(0, (opts.seconds - elapsed) * 1000));
  const rendered = await new Promise<{ a: Float32Array; b: Float32Array; start: number }>((resolve) => {
    rec.port.onmessage = (e) => resolve(e.data);
    rec.port.postMessage({ stop: true });
  });
  try {
    source.stop();
  } catch {
    /* already stopped */
  }
  source.disconnect();
  dev.dispose?.();
  rec.disconnect();
  const startOff = Math.max(0, Math.round(t0 * sr) - rendered.start);
  const out = rendered.a.subarray(startOff);
  let finite = true;
  for (let i = 0; i < out.length; i++) if (!Number.isFinite(out[i])) finite = false;
  return { sr, out, finite, windows, settled };
}

// One run → the worst step ratio around each gesture. A device that is genuinely click-free reads
// ~1‥3 here (the median-step normaliser makes ~1 the floor for any material).
(globalThis as unknown as { fxlabLiveGesture: (spec: LiveGestureSpec) => Promise<LiveGestureResult> }).fxlabLiveGesture = async (spec) => {
  const runs: number[][] = [];
  const after: number[][] = [];
  const whenMs: number[][] = [];
  let finite = true;
  let quiet = 0;
  for (let i = 0; i < (spec.n || 3); i++) {
    const r = await renderLive(spec.kind, spec.params || {}, {
      signal: spec.signal || "tone",
      seconds: spec.seconds || 3,
      toneHz: spec.toneHz,
      toneAmp: spec.toneAmp,
      gestures: spec.gestures,
      startBypassed: spec.startBypassed,
    });
    if (!r.finite) finite = false;
    quiet = Math.max(quiet, peakOf(r.out));
    runs.push(r.windows.map((w) => maxAbsStep(r.out, Math.round(w[0] * r.sr), Math.round(w[1] * r.sr))));
    after.push(r.settled.map((w) => maxAbsStep(r.out, Math.round(w[0] * r.sr), Math.round(w[1] * r.sr))));
    whenMs.push(
      r.windows.map((w) => {
        const hit = maxAbsStepAt(r.out, Math.round(w[0] * r.sr), Math.round(w[1] * r.sr));
        // ms relative to the GESTURE, not the window (the window opens 50 ms early)
        return Math.round((hit.at / r.sr - w[0]) * 1000);
      }),
    );
  }
  // WORST across runs, per gesture: unlike the offline path there is no quirk to filter out, so a
  // spike here is the device's own — taking the minimum would be hiding it.
  // Reported as the audit's own discriminator: the gesture's biggest jump over the biggest jump
  // the material makes on its own, before and after.
  const control = Math.max(...runs.map((r) => r[0] ?? 0));
  const worst = spec.gestures.map((_, i) => {
    const w = Math.max(...runs.map((r) => r[i] ?? 0));
    const s = Math.max(...after.map((r) => r[i] ?? 0));
    const b = i > 0 ? Math.max(...after.map((r) => r[i - 1] ?? 0)) : control;
    return Math.round((w / Math.max(b, s, 1e-6)) * 100) / 100;
  });
  const settledWorst = spec.gestures.map((_, i) => Math.max(...after.map((r) => r[i] ?? 0)));
  const when = spec.gestures.map((_, i) => whenMs.map((r) => r[i] ?? 0));
  return { runs, worst, settled: settledWorst, when, finite, peak: Math.round(quiet * 1000) / 1000 };
};
export interface LiveGestureSpec {
  kind: FxKind;
  params?: Record<string, number>;
  gestures: LiveGesture[];
  signal?: "tone" | "pink" | "noise";
  seconds?: number;
  toneHz?: number;
  toneAmp?: number;
  startBypassed?: boolean;
  n?: number;
}
export interface LiveGestureResult {
  runs: number[][];
  worst: number[];
  settled: number[]; // the same score for the untouched state each gesture LEFT BEHIND
  when: number[][]; // ms from the gesture at which the biggest step landed, per run
  finite: boolean;
  peak: number;
}

// ---- THE LIVE AUDIT ---------------------------------------------------------------------------
// Every worklet-bearing device's splice-prone gestures, re-measured on the real-time path. The
// offline verdicts these replace were not wrong so much as MEANINGLESS: the suspend quirk injects
// a ×12 step into any worklet graph 100% of the time, so a device could only ever look guilty,
// and "no click" was never something the offline path could have told us.
//
// Gestures are batched per device — 1.2 s apart in ONE render, each with its own window — because
// this path costs WALL-CLOCK seconds, not CPU. State is cumulative and ordered on purpose (a
// style switch out is measured right after the switch in: the teardown is the other half of the
// experiment, and it's the half that holds a node the signal is still running through).
// `limit` overrides LIVE_STEP_LIMIT for one gesture, and must carry its reason: an exemption
// without a stated why is just a silenced test.
// `quick` marks the subset --live-audit-quick runs (the cheap pre-commit pass).
const LIVE_AUDIT: { kind: FxKind; label: string; quick?: boolean; params?: Record<string, number>; gestures: (LiveGesture & { what: string; limit?: number })[] }[] = [
  {
    kind: "reverb",
    label: "REVERB",
    quick: true,
    params: { mix: 0.5, size: 0.5, decay: 0.6 },
    gestures: [
      { what: "control (no gesture)", t: 1.0, param: "__none", to: 0 },
      { what: "SIZE drag .2→.9", t: 2.2, param: "size", from: 0.2, to: 0.9, ms: 300 },
      { what: "DECAY drag .2→.95", t: 3.6, param: "decay", from: 0.2, to: 0.95, ms: 300 },
      { what: "STYLE Hall→Plate", t: 5.0, param: "style", to: 2 },
      { what: "FREEZE on", t: 6.2, param: "freeze", to: 1 },
      { what: "FREEZE off", t: 7.4, param: "freeze", to: 0 },
    ],
  },
  {
    kind: "crush",
    label: "CRUSH",
    quick: true,
    params: { mix: 1, bits: 0.7, rate: 0.7 },
    gestures: [
      { what: "control (no gesture)", t: 1.0, param: "__none", to: 0 },
      { what: "BITS drag .9→.1", t: 2.2, param: "bits", from: 0.9, to: 0.1, ms: 300 },
      { what: "RATE drag .9→.15", t: 3.6, param: "rate", from: 0.9, to: 0.15, ms: 300 },
      { what: "MODE switch", t: 5.0, param: "mode", to: 1 },
      { what: "CUT sweep", t: 6.2, param: "cut", from: 1, to: 0.2, ms: 300 },
    ],
  },
  {
    kind: "comp",
    label: "COMP",
    quick: true,
    params: { mix: 1, threshold: 0.4, ratio: 0.5 },
    gestures: [
      { what: "control (no gesture)", t: 1.0, param: "__none", to: 0 },
      { what: "MODE GLUE→LIMIT", t: 2.2, param: "mode", to: 3 },
      { what: "MODE LIMIT→GLUE", t: 3.4, param: "mode", to: 0 },
      { what: "LOOKAHEAD change", t: 4.6, param: "lookahead", from: 0, to: 1, ms: 200 },
      { what: "ATTACK drag", t: 5.8, param: "attack", from: 0.9, to: 0.05, ms: 300 },
      { what: "RATIO drag", t: 7.0, param: "ratio", from: 0.1, to: 0.95, ms: 300 },
    ],
  },
  {
    kind: "saturator",
    label: "SAT",
    quick: true,
    params: { mix: 1, drive0: 0.5, drive1: 0.5, drive2: 0.5 },
    gestures: [
      { what: "control (no gesture)", t: 1.0, param: "__none", to: 0 },
      { what: "STYLE TUBE→TAPE (worklet in)", t: 2.2, param: "style0", to: 1 },
      { what: "STYLE TAPE→CLIP (worklet out)", t: 3.4, param: "style0", to: 2 },
      { what: "DRIVE drag", t: 4.6, param: "drive0", from: 0.1, to: 0.95, ms: 300 },
      { what: "XOVER drag", t: 6.0, param: "xover0", from: 0.2, to: 0.8, ms: 300 },
    ],
  },
  {
    kind: "gate",
    // ★ SHAPE is pinned in `params`, not switched mid-list. Each shape has its own step floor —
    // RAMP snaps shut by design and reads ×22 where SQUARE reads ×2 — so a shape change inside
    // the run moves the baseline under every gesture after it, and they all get judged against
    // the wrong idle. If a shape switch itself needs measuring it deserves its own run.
    label: "GATE",
    params: { mix: 1, depth: 0.85, shape: 0 },
    gestures: [
      { what: "control (no gesture)", t: 1.0, param: "__none", to: 0 },
      { what: "RATE drag", t: 2.2, param: "rate", from: 0.1, to: 0.8, ms: 300 },
      { what: "DEPTH drag", t: 3.6, param: "depth", from: 0.1, to: 1, ms: 300 },
      { what: "SYNC toggle", t: 5.0, param: "sync", to: 0 },
      { what: "ALIGN off", t: 6.2, param: "align", to: 0 },
      { what: "SHIFT drag (offbeat)", t: 7.4, param: "shift", from: 0, to: 0.5, ms: 300 },
    ],
  },
  {
    kind: "delay",
    label: "DELAY",
    params: { mix: 0.5, feedback: 0.4 },
    gestures: [
      { what: "control (no gesture)", t: 1.0, param: "__none", to: 0 },
      // Changing a delay's TIME re-reads a ringing tail from a different place in the line —
      // every one of the three TIME MODES lands at 1.46‥1.60, including Digital, whose whole
      // design is to switch instantly. A gesture that scores the same however carefully it is
      // implemented is measuring the tail, not the implementation; 1.8 is its own bound.
      { what: "TIME drag (perturbs the tail)", t: 2.2, param: "time", from: 0.2, to: 0.7, ms: 300, limit: 1.8 },
      { what: "FEEDBACK drag", t: 3.6, param: "feedback", from: 0.1, to: 0.85, ms: 300 },
    ],
  },
];
// ★ THE VERDICT IS RELATIVE TO THE DEVICE SITTING STILL, NOT AN ABSOLUTE.
// A raw step ratio measures the MATERIAL, and some devices legitimately produce steps as their
// whole function: GATE chops the signal (its control run reads ×21 with nobody touching it), a
// crusher quantises, a saturator squares off corners. Judging those against a fixed limit convicts
// the effect of being the effect — the same "a green measurement is not a green feature" trap
// fxlab already carries a warning about, running in its other direction.
// So every device's gesture list OPENS with a `__none` control run, and a gesture passes if it is
// no worse than max(4, control × 1.6). A device whose control is already high can only ever be
// cleared of making things WORSE — and that is the honest limit of what this metric can say
// about it, which is a thing the report has to admit rather than paper over.
// How much bigger than the material's own biggest jump a gesture may be. 1.5× is generous: a
// clean gesture sits at ~1.0 (it never out-jumps the signal), a splice lands in the tens.
const LIVE_STEP_LIMIT = 1.5;
// `quick` = one run per device, and only the devices whose click behaviour the OFFLINE path
// cannot measure at all (the worklet ones — see the suspend quirk). The full pass is ~8 minutes
// of wall clock because it is real-time by necessity; this is the version worth running before
// every commit rather than occasionally.
(globalThis as unknown as { fxlabLiveAudit: (n?: number, quick?: boolean) => Promise<ModAuditResult> }).fxlabLiveAudit = async (n = 3, quick = false) => {
  const checks: ModAuditCheck[] = [];
  for (const d of LIVE_AUDIT) {
    if (quick && !d.quick) continue;
    const runs: number[][] = [];
    const after: number[][] = [];
    let finite = true;
    for (let i = 0; i < n; i++) {
      const r = await renderLive(d.kind, d.params || {}, {
        signal: "tone",
        seconds: Math.max(...d.gestures.map((g) => g.t)) + 2,
        toneAmp: 0.5,
        gestures: d.gestures,
      });
      if (!r.finite) finite = false;
      runs.push(r.windows.map((w) => maxAbsStep(r.out, Math.round(w[0] * r.sr), Math.round(w[1] * r.sr))));
      after.push(r.settled.map((w) => maxAbsStep(r.out, Math.round(w[0] * r.sr), Math.round(w[1] * r.sr))));
    }
    // Gesture 0 is the control by construction (see LIVE_AUDIT) — the device idling.
    const control = Math.max(...runs.map((r) => r[0] ?? 0));
    d.gestures.forEach((g, i) => {
      const worst = Math.max(...runs.map((r) => r[i] ?? 0));
      const settled = Math.max(...after.map((r) => r[i] ?? 0));
      const isControl = g.param === "__none";
      // ★ THE FLOOR IS THE HIGHER OF THE STATE BEFORE THIS GESTURE AND THE STATE AFTER IT, in
      // absolute step size. A control that legitimately sharpens the signal (a crossover moving
      // content into a hot band, a saturator style whose hysteresis model has 3× the sample-to-
      // sample slope of the static curves) leaves steppier material behind — that is the effect,
      // not a click. Only a jump that beats BOTH neighbouring steady states is the gesture's own.
      //
      // "Before" is the PREVIOUS gesture's settled state, not the run's opening control: a window
      // spans the changeover, so it necessarily contains some of the material it is leaving, and
      // charging that to the gesture made every switch out of a steppy style look like a splice.
      const before = i > 0 ? Math.max(...after.map((r) => r[i - 1] ?? 0)) : control;
      const floor = Math.max(before, settled, 1e-6);
      const ratio = worst / floor;
      const limit = g.limit ?? LIVE_STEP_LIMIT;
      checks.push({
        name: `${d.label} ${g.what}`,
        value: Math.round(ratio * 100) / 100,
        unit: "× material",
        // The control run can't fail — it IS the floor.
        pass: isControl || ratio <= limit,
        detail: isControl
          ? `idle: biggest step ${control.toExponential(2)}`
          : `step ${worst.toExponential(2)} vs material ${floor.toExponential(2)} (before ${before.toExponential(2)}, after ${settled.toExponential(2)})`,
      });
    });
    checks.push({ name: `${d.label} output finite`, value: finite ? 1 : 0, unit: "bool", pass: finite, detail: "no NaN/Inf reached the output" });
  }
  return { ok: checks.every((c) => c.pass), checks };
};
async function renderModLive(
  params: Record<string, number>,
  opts: { signal: "tone" | "pink"; seconds: number; toneHz?: number; toneAmp?: number; gestures: { t: number; fn: (dev: ModFx) => void }[]; throwOn?: boolean },
): Promise<ModRender & { gestureT: number[] }> {
  const ctx = await liveContext();
  const sr = ctx.sampleRate;
  const dev = new ModFx(ctx);
  dev.reset();
  for (const k in params) dev.setParam(k, params[k]);
  (dev as unknown as { flushRebuild?: () => void }).flushRebuild?.();
  if (opts.throwOn) (dev as unknown as { setThrow?: (on: boolean) => void }).setThrow?.(true);
  const rec = new AudioWorkletNode(ctx, "fxlabrec", { numberOfInputs: 2, numberOfOutputs: 1, outputChannelCount: [1] });
  const source = makeSignal(ctx as unknown as Ctx, opts.signal, sr, opts.toneHz ?? 1000, opts.toneAmp ?? 0.5);
  if (source instanceof AudioBufferSourceNode) source.loop = true;
  source.connect(dev.input);
  dev.output.connect(rec, 0, 0);
  source.connect(rec, 0, 1);
  const sink = ctx.createGain();
  sink.gain.value = 0;
  rec.connect(sink).connect(ctx.destination);
  const t0 = ctx.currentTime + 0.05;
  source.start(t0);
  const gestureT: number[] = [];
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const timeline = [...opts.gestures].sort((a, b) => a.t - b.t);
  let elapsed = 0;
  for (const g of timeline) {
    await sleep(Math.max(0, (g.t - elapsed) * 1000));
    elapsed = g.t;
    gestureT.push(ctx.currentTime - t0);
    g.fn(dev);
  }
  await sleep(Math.max(0, (opts.seconds - elapsed) * 1000));
  const rendered = await new Promise<{ a: Float32Array; b: Float32Array; start: number }>((resolve) => {
    rec.port.onmessage = (e) => resolve(e.data);
    rec.port.postMessage({ stop: true });
  });
  try {
    source.stop();
  } catch {
    /* already */
  }
  source.disconnect();
  dev.dispose();
  rec.disconnect();
  // trim to t0-relative frames
  const startOff = Math.max(0, Math.round(t0 * sr) - rendered.start);
  const out = rendered.a.subarray(startOff);
  const dryRaw = rendered.b.subarray(startOff);
  const dryGain = (dev as unknown as { dryLevel?: number }).dryLevel ?? 1;
  const offS = ((dev as unknown as { dryOffsetSec?: number }).dryOffsetSec ?? 0) * sr;
  const dry = new Float32Array(out.length);
  for (let i = 0; i < out.length; i++) {
    const p = i - offS;
    const j = Math.floor(p);
    const f = p - j;
    dry[i] = j >= 0 && j + 1 < dryRaw.length ? dryRaw[j] * (1 - f) + dryRaw[j + 1] * f : 0;
  }
  const wet = new Float32Array(out.length);
  let finite = true;
  for (let i = 0; i < out.length; i++) {
    wet[i] = out[i] - dryGain * dry[i];
    if (!Number.isFinite(out[i])) finite = false;
  }
  return { sr, out, outR: out, dry, mod: new Float32Array(0), phase: new Float32Array(0), wet, finite, gestureT };
}
async function liveGestureStep(params: Record<string, number>, opts: Parameters<typeof renderModLive>[1]): Promise<{ step: number; r: ModRender & { gestureT: number[] } }> {
  const r = await renderModLive(params, opts);
  let step = 0;
  for (const t of r.gestureT) step = Math.max(step, maxStepRatio(r.out, Math.round((t - 0.1) * r.sr), Math.round((t + 0.4) * r.sr)));
  return { step, r };
}
(globalThis as unknown as { fxlabModLiveGesture: (params: Record<string, number>, param: string, to: number, n: number) => Promise<number[]> }).fxlabModLiveGesture = async (params, param, to, n) => {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const { step } = await liveGestureStep(params, { signal: "tone", seconds: 3, gestures: [{ t: 1.5, fn: (d) => { if (param !== "__none") d.setParam(param, to); } }] });
    out.push(Math.round(step * 100) / 100);
  }
  return out;
};

// ---- STEM TAPS — a NULL TEST of the routing substrate ----------------------------------------
// The claim the stem-FX chains rest on: outputs [1..4] of the stretch worklet, summed, ARE the
// mix on output [0]. Not "close" — the same grain, the same window, the same read cursor, so the
// difference should be float dust. This measures it the only way that cannot flatter itself:
// sum the four taps, subtract the mix, and look at what is left. A wiring error, an off-by-one in
// the side FIFOs, or a tap reading a stale cursor all survive a peak/RMS check and all fail this.
//
// ⚠ It also asserts its own INPUT (obligation e2cb519e): a null test over silence cancels
// perfectly and proves nothing, so the residual is reported RELATIVE to the mix's own level and
// the mix level is reported too. Read both numbers or read neither.
(globalThis as unknown as {
  fxlabStemTaps: (opts?: { seconds?: number; pitch?: number; speed?: number; stemGains?: number[]; noTaps?: boolean }) => Promise<{
    sr: number; mixPeak: number; mixRms: number; residPeak: number; residRms: number; nullDb: number; finite: boolean; diag: Record<string, number> | null;
  }>;
}).fxlabStemTaps = async (opts = {}) => {
  // ⚠ REAL-TIME, not offline — and not for the usual reason. An OfflineAudioContext renders far
  // faster than the control thread drains a worklet's port queue: of six setup messages exactly
  // ONE (loadPcm) reached the processor before the render finished, so `start` never arrived and
  // every case measured silence. The first version of this probe reported that silence as a
  // perfect null. It is only visible at all because the numbers are printed next to the mix level
  // they are relative to (obligation e2cb519e) — read a bare "−inf dB null" and you would ship it.
  const seconds = opts.seconds ?? 2;
  const ctx = await liveContext();
  const sr = ctx.sampleRate;

  // FOUR DISTINGUISHABLE STEMS: a different frequency per group, and a phase-shifted right
  // channel, so a tap wired to the wrong output — or two taps sharing one FIFO, or R copied from
  // L — leaves a residual instead of cancelling anyway.
  const n = Math.ceil((seconds + 4) * sr);
  const freqs = [55, 110, 440, 1320];
  const gL: Float32Array[] = [], gR: Float32Array[] = [];
  for (let g = 0; g < 4; g++) {
    const L = new Float32Array(n), R = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      L[i] = 0.2 * Math.sin(2 * Math.PI * freqs[g] * t);
      R[i] = 0.2 * Math.sin(2 * Math.PI * freqs[g] * t + 0.7);
    }
    gL.push(L); gR.push(R);
  }

  const node = new AudioWorkletNode(ctx, "stretch", { numberOfOutputs: 5, outputChannelCount: [2, 2, 2, 2, 2], processorOptions: { deckId: "LAB" + Math.round(sr) } });
  let diag: Record<string, number> | null = null;
  node.port.onmessage = (e: MessageEvent) => { const m = e.data as { type?: string }; if (m?.type === "diag") diag = e.data as Record<string, number>; };
  if (!opts.noTaps) node.port.postMessage({ type: "taps", on: true });
  node.port.postMessage({ type: "loadPcm", gL, gR, length: n, int16: false });
  const gains = opts.stemGains ?? [1, 1, 1, 1];
  for (let g = 0; g < 4; g++) node.port.postMessage({ type: "stemGain", index: g, value: gains[g] });
  if (opts.speed !== undefined) node.port.postMessage({ type: "speed", value: opts.speed });
  if (opts.pitch !== undefined) node.port.postMessage({ type: "pitch", value: opts.pitch });
  node.port.postMessage({ type: "start", offset: 0 });

  // Input 0 = the mix (output 0). Input 1 = the four taps summed with the mix INVERTED — one
  // graph, one grain seating, so there is no chance of differencing two separate renders.
  const rec = new AudioWorkletNode(ctx, "fxlabrec", { numberOfInputs: 2, numberOfOutputs: 1, outputChannelCount: [1] });
  node.connect(rec, 0, 0);
  const resid = ctx.createGain();
  const inv = ctx.createGain(); inv.gain.value = -1;
  node.connect(inv, 0); inv.connect(resid);
  for (let g = 0; g < 4; g++) node.connect(resid, g + 1);
  resid.connect(rec, 0, 1);
  const sink = ctx.createGain(); sink.gain.value = 0;
  rec.connect(sink).connect(ctx.destination);

  await new Promise((r) => setTimeout(r, seconds * 1000));
  const got = await new Promise<{ a: Float32Array; b: Float32Array }>((resolve) => {
    rec.port.onmessage = (e: MessageEvent) => resolve(e.data as { a: Float32Array; b: Float32Array });
    rec.port.postMessage({ stop: true });
  });
  node.port.postMessage({ type: "stop" });
  node.port.postMessage({ type: "clear" });
  try { node.disconnect(); rec.disconnect(); resid.disconnect(); inv.disconnect(); sink.disconnect(); } catch { /* ignore */ }

  const mix = got.a, res = got.b;
  // Skip the first 300 ms: the declick fade-in and the FIFO's first fill are start-up, not routing.
  const s0 = Math.min(mix.length, Math.round(0.3 * sr));
  let mp = 0, rp = 0, ms = 0, rs = 0, finite = true;
  for (let i = s0; i < mix.length; i++) {
    const a = Math.abs(mix[i]), b = Math.abs(res[i]);
    if (a > mp) mp = a;
    if (b > rp) rp = b;
    ms += mix[i] * mix[i]; rs += res[i] * res[i];
    if (!Number.isFinite(mix[i]) || !Number.isFinite(res[i])) finite = false;
  }
  const cnt = Math.max(1, mix.length - s0);
  const mixRms = Math.sqrt(ms / cnt), residRms = Math.sqrt(rs / cnt);
  return { sr, mixPeak: mp, mixRms, residPeak: rp, residRms, nullDb: 20 * Math.log10((residRms + 1e-30) / (mixRms + 1e-30)), finite, diag };
};
