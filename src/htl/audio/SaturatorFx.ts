// Multiband saturator — Decapitator flavor under Saturn glass. NATIVE Web Audio for 4 of 5
// styles: a Linkwitz-Riley crossover splits the signal into N bands, each driven into a
// `WaveShaperNode` (4x oversampled — the browser anti-aliases) carrying that BAND'S OWN style
// curve. TAPE is the one style with real memory (see tapeWorklet.ts) — a WaveShaper is
// structurally incapable of hysteresis (the same input can never produce two different
// outputs), so it's the one style that gets a worklet, with a native-curve fallback if the
// module never loads (same resilience pattern as ModFx's chorus/flanger → native DelayNode).
//
//   input ─┬─→ dry·(1−mix) ─────────────────────────────────────────────────────→ output
//          └─→ [LR4 split + allpass phase-comp] → band i: drive+bias → shaper|worklet → dcBlock
//                                                    → voicing[i] → makeup[i] → out[i] ─┐
//                                                                                  sum → wet
//
// Each band carries its OWN style/bias/punish/heat/out — "multiband" used to mean only DRIVE
// varied per band while the character (which curve, biased how, how hot, how loud in the mix)
// was one shared setting for the whole device; TUBE-lows-with-DIODE-highs on the SAME saturator,
// each pushed and balanced independently, is the actual Saturn-style promise multiband
// saturation is supposed to deliver. PUNISH is a per-band toggle (a "hit the hot zone" gesture,
// same precedent as FREEZE elsewhere in the rack); HEAT is the per-band continuous knob that sets
// how hot punish actually pushes, once that band engages it. OUT is a per-band trim AFTER the
// (automatic, unrelated) makeup gain — a deliberate manual rebalance of each band's contribution
// to the final mix, not a correction. There is no device-wide tone/output stage left: a single
// post-sum shelf tilt was redundant with per-band VOICING (already a fixed tonal identity per
// STYLE) and strictly less capable than balancing the three bands directly.
//
// Drive is a PRE-GAIN node (real-time, per band); curves regenerate only on style/punish/heat
// change. Bias is a DC offset summed before the shaper (asymmetry → even harmonics), now scaled
// independently per band off one shared ConstantSourceNode. The band count + crossover tree are
// built in a loop, so widening past 3 bands is a constant change — EXCEPT the allpass phase
// compensation below, which is written for exactly 2 crossovers (3 bands); widening further
// would need a general N-way correction, not attempted here.
import { BaseFxDevice, type FxKind } from "./Fx";
import { clamp, clamp01, logMap, safeDisconnect } from "./fxDsp";

export const SAT_STYLES = ["TUBE", "TAPE", "CLIP", "FOLD", "DIODE"] as const;
export type SatStyle = (typeof SAT_STYLES)[number];
const TAPE_STYLE = 1;

const CURVE_LEN = 2048;
const DC_BLOCK_HZ = 12;
// ★ Web Audio reads Q in DECIBELS for lowpass/highpass (alpha = sin(w0)/(2·10^(Q/20))) — see the
// history in the git blame for why −3.01 (true Butterworth) replaced the old 0.7071 here.
const LR_Q = -3.01;
// ★ Phase-compensation allpass for the outer bands (see the "crossover flat-sum" note below) —
// this is a LINEAR Q (alpha = sin(w0)/(2·Q)), a different convention than LR_Q above despite
// both wanting the same alpha at a single stage; empirically verified (see the derivation
// script referenced in the deploy ledger, not reproduced here) to flatten the 3-way sum to
// <0.03dB across realistic crossover spreads, worst-case ~0.2dB on an extremely narrow split.
const XOVER_AP_QLIN = 1.6;
// ★ CROSSOVER FLAT-SUM FINDING (open thread cfa31dd0): the topology below — band0=LP4(f0),
// band1=HP4(f0)·LP4(f1), band2=HP4(f1), all fed in parallel from raw input — is the standard
// way to build a 3-way LR crossover, and the standard way it fails to sum flat: band1 carries
// TWICE the filter order of band0/band2, so it picks up extra phase they don't share. The fix
// is the allpass pair below, phase-matching each outer band to the "other" crossover's order.
// Verified by replicating Web Audio's exact biquad coefficients in plain JS (no audio context
// needed — it's pure LTI filter math) and complex-summing the three band responses across a log
// sweep: UNCORRECTED, the topology itself is only ~0.1–0.2dB of ripple at the crossover points —
// nowhere near the +2…+4dB previously measured via fxlab. That earlier number almost certainly
// came from fxlab's own measurement setup (0dBFS probe vs. the −12dBFS level auto-makeup is
// calibrated against) rather than a real crossover defect, consistent with the still-open
// e2cb519e finding that fxlab needs an input/output assertion before its numbers can be trusted.
// The allpass below is still applied — it's free, verified, and correct — but don't expect it to
// explain a multi-dB reading; a fresh, trustworthy fxlab sweep is the real next step there.

// 0..1 knob → pre-gain into the curve: −10 dB … +20 dB. See the header for why it starts below
// unity (a WaveShaper's domain is [−1,1] and drive 0 must be genuinely transparent).
const driveGain = (ext: number) => Math.pow(10, (clamp01(ext) * 30 - 10) / 20);
// 0..1 → log frequency 20 Hz‥20 kHz (crossover points).
const extToHz = logMap(20, 20000);
const hzToExt = (hz: number) => Math.log(clamp(hz, 20, 20000) / 20) / Math.log(1000);
// PUNISH steepness range — HEAT (0..1, device-wide) picks where in this range a punished band
// sits; unpunished always stays at the old fixed baseline (1.4) regardless of HEAT.
const HEAT_MIN = 1.6;
const HEAT_MAX = 3.4;
const HOT_BASE = 1.4;

// Per-style transfer function over x∈[-1,1]. WaveShaperNode clamps its INPUT to [-1,1] then
// looks up the curve, so drive (pre-gain) pushes the signal toward the saturated/folded edges.
// FOLD bakes the fold into the domain since pre-gain can't push past the clamp. TAPE's curve
// here is the FALLBACK only (see buildBandEngine) — the live TAPE sound is the worklet's
// stateful hysteresis model; this is what a band degrades to if that module never loads.
function makeCurve(style: number, hot: number): Float32Array<ArrayBuffer> {
  const c = new Float32Array(CURVE_LEN);
  for (let i = 0; i < CURVE_LEN; i++) {
    const x = (i / (CURVE_LEN - 1)) * 2 - 1;
    const k = x * hot;
    let y: number;
    switch (style) {
      case 0: // TUBE — round + ASYMMETRIC: a soft sigmoid plus an EVEN (k²) term so the + and
        // − halves differ → 2nd-harmonic warmth (single-ended tube). The DC the k² adds is
        // removed by the per-band DC blocker, leaving the even harmonic.
        y = Math.tanh(1.5 * k) + 0.18 * k * k;
        break;
      case 1: // TAPE fallback — gentle soft-knee compression that never fully clips.
        y = k / (1 + 0.6 * Math.abs(k));
        break;
      case 2: // CLIP — near-HARD clip (a thin cubic knee then flat) → strong ODD harmonics,
        // buzzy/transistor. Deliberately the opposite of TUBE/TAPE's soft round.
        y = k <= -1 ? -1 : k >= 1 ? 1 : 1.5 * k - 0.5 * k * k * k;
        break;
      case 3: // FOLD — sine wavefolder; peaks then folds back on itself → inharmonic, metallic
        y = Math.sin(k * Math.PI * 0.95);
        break;
      case 4: // DIODE — heavily asymmetric: the + half saturates hard, the − half stays gentle
        // → octave-up + gnarly fuzz, a rectifier-like bite. Voiced nasal below.
        y = k >= 0 ? Math.tanh(2.4 * k) : -0.45 * (1 - Math.exp(1.9 * k));
        break;
      default:
        y = Math.tanh(k);
    }
    c[i] = clamp(y, -1, 1);
  }
  return normalizeSlope(c);
}

// ★ UNITY SMALL-SIGNAL SLOPE — see makeCurve's history: every curve is EXPANSIVE near zero on
// its own, so each is divided by its own slope at the origin. A saturator must be TRANSPARENT
// at zero drive and bend only as it's pushed; the peak is deliberately NOT renormalised
// afterwards (the curve saturates below full scale on purpose — makeupFor() pays the loudness
// back).
function normalizeSlope(c: Float32Array<ArrayBuffer>): Float32Array<ArrayBuffer> {
  const i0 = Math.floor((c.length - 1) / 2);
  const dx = 2 / (c.length - 1);
  const slope = (c[i0 + 1] - c[i0]) / dx;
  if (!(slope > 0.01)) return c; // degenerate curve — don't divide by ~0
  for (let i = 0; i < c.length; i++) c[i] = clamp(c[i] / slope, -1, 1);
  return c;
}

// The curve as the WaveShaper reads it: input clamped to [−1,1], then linear interpolation.
function curveAt(c: Float32Array<ArrayBuffer>, x: number): number {
  const t = ((clamp(x, -1, 1) + 1) / 2) * (c.length - 1);
  const i = Math.floor(t);
  const f = t - i;
  return i + 1 < c.length ? c[i] * (1 - f) + c[i + 1] * f : c[i];
}

// ★ REAL AUTO-MAKEUP, MEASURED: push a reference tone through the ACTUAL curve at the ACTUAL
// drive, take its RMS, compensate by exactly that — so cranking drive pushes the signal harder
// INTO the curve (more saturation) at a constant level. DRIVE changes character, not loudness.
const MAKEUP_REF = 0.25; // reference amplitude ≈ −12 dBFS: a real programme level, not full scale
function makeupFor(c: Float32Array<ArrayBuffer>, drive: number): number {
  const N = 512;
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < N; i++) {
    const y = curveAt(c, drive * MAKEUP_REF * Math.sin((2 * Math.PI * i) / N));
    sum += y;
    sumSq += y * y;
  }
  const mean = sum / N;
  const rmsOut = Math.sqrt(Math.max(0, sumSq / N - mean * mean)); // DC-removed, like the band's dc blocker
  const rmsIn = MAKEUP_REF / Math.SQRT2;
  return clamp(rmsOut > 1e-6 ? rmsIn / rmsOut : 1, 0.05, 20);
}

// Mirrors makeupFor() above, but for the TAPE worklet's STATEFUL recurrence instead of a static
// curve lookup (must track tapeWorklet.ts's own constants). Runs several reference-tone cycles
// so the one-pole lag settles, then measures only the last cycle.
const TAPE_POLE_HZ = 9000; // must match tapeWorklet.ts
const TAPE_HYST_W = 0.18; // must match tapeWorklet.ts
function makeupForTape(hot: number, drive: number): number {
  const SR = 48000; // a representative rate — the estimate only needs to be close, not exact
  const REF_HZ = 1000;
  const period = SR / REF_HZ;
  const N = Math.round(period * 4);
  const poleAlpha = 1 - Math.exp((-2 * Math.PI * TAPE_POLE_HZ) / SR);
  const h = hot > 1e-4 ? hot : 1e-4;
  let state = 0;
  let prevX = 0;
  let sum = 0;
  let sumSq = 0;
  let count = 0;
  const lastCycleStart = N - Math.round(period);
  for (let i = 0; i < N; i++) {
    const x = drive * MAKEUP_REF * Math.sin((2 * Math.PI * i) / period);
    state += (x - state) * poleAlpha;
    const d = x - prevX;
    const loop = (d > 0 ? TAPE_HYST_W : d < 0 ? -TAPE_HYST_W : 0) * h;
    const y = Math.tanh(h * state + loop) / h;
    prevX = x;
    if (i >= lastCycleStart) {
      sum += y;
      sumSq += y * y;
      count++;
    }
  }
  const mean = sum / count;
  const rmsOut = Math.sqrt(Math.max(0, sumSq / count - mean * mean));
  const rmsIn = (drive * MAKEUP_REF) / Math.SQRT2;
  return clamp(rmsOut > 1e-6 ? rmsIn / rmsOut : 1, 0.05, 20);
}

interface Xover {
  lp: [BiquadFilterNode, BiquadFilterNode]; // LR4 lowpass pair (feeds the band below)
  hp: [BiquadFilterNode, BiquadFilterNode]; // LR4 highpass pair (feeds the band above)
}

// Per-style baked tonal VOICING (one post-shaper filter per band) — the Decapitator-model
// trick: the curve gives the harmonics, the voicing gives each model its EQ identity (tape
// dark, transistor bright, the asymmetric ones honk). Separate from the user TONE knob.
const VOICING: { type: BiquadFilterType; f: number; g: number; q: number }[] = [
  { type: "peaking", f: 380, g: 2.5, q: 0.7 }, // TUBE  — low-mid warmth
  { type: "highshelf", f: 5500, g: -5, q: 0.7 }, // TAPE  — HF rolloff (dark, vintage)
  { type: "highshelf", f: 3500, g: 3.5, q: 0.7 }, // CLIP  — bright transistor edge
  { type: "peaking", f: 2000, g: 0, q: 0.7 }, // FOLD  — flat (let the folds speak)
  { type: "peaking", f: 1400, g: 4.5, q: 1.3 }, // DIODE — nasal fuzz honk
];

export class SaturatorFx extends BaseFxDevice {
  readonly kind: FxKind = "saturator";
  static readonly BANDS = 3;

  // Permanent per-band nodes (created once, never torn down).
  private readonly drives: GainNode[] = [];
  private readonly biasGains: GainNode[] = [];
  private readonly shaperIns: GainNode[] = []; // drive + bias sum → feeds shaper OR worklet
  private readonly dcBlocks: BiquadFilterNode[] = [];
  private readonly voicings: BiquadFilterNode[] = []; // per-band now (style is per-band)
  private readonly bandGains: GainNode[] = []; // automatic makeup (curve/drive-derived, not a knob)
  private readonly outGains: GainNode[] = []; // the user's per-band OUT trim, after makeup
  // Swappable per-band nonlinearity — exactly one of these is non-null per band at a time.
  private readonly shapers: (WaveShaperNode | null)[] = [];
  private readonly tapeNodes: (AudioWorkletNode | null)[] = [];
  private readonly engineGains: (GainNode | null)[] = []; // one per band, so a style swap can fade
  private readonly aligns: (DelayNode | null)[] = []; // TAPE-only: pays back the shaper's oversampling delay

  private readonly xovers: Xover[] = []; // BANDS-1 crossovers (retunable)
  private apLow: [BiquadFilterNode, BiquadFilterNode] | null = null; // band0 phase-comp, tuned to the FAR crossover
  private apHigh: [BiquadFilterNode, BiquadFilterNode] | null = null; // last band phase-comp, tuned to the FIRST crossover
  private readonly biasSrc: ConstantSourceNode; // fixed DC=1; each band scales it independently
  private readonly bandSum: GainNode;

  private readonly _style: number[]; // per band
  private readonly _punish: boolean[]; // per band
  private readonly _bias: number[]; // per band, 0..1
  private readonly _heat: number[]; // per band, 0..1 — how hot a punished band gets
  private readonly _out: number[]; // per band, 0..1 (0.5 = unity) — manual mix balance
  private readonly _drive: number[]; // 0..1 per band
  private readonly _xfreqExt: number[]; // 0..1 per crossover
  private _throwBoost = 1; // pad-throw multiplier into all band drives

  constructor(ctx: AudioContext) {
    super(ctx, 1.0); // insert: full wet by default
    const B = SaturatorFx.BANDS;
    this._style = new Array(B).fill(0);
    this._punish = new Array(B).fill(false);
    this._bias = new Array(B).fill(0);
    this._heat = new Array(B).fill(0.5);
    this._out = new Array(B).fill(0.5);
    this._drive = new Array(B).fill(0.4);
    this._xfreqExt = [hzToExt(250), hzToExt(2500)].slice(0, B - 1);

    this.bandSum = ctx.createGain();
    this.biasSrc = ctx.createConstantSource();
    this.biasSrc.offset.value = 1; // fixed unity DC; per-band GainNode scales it to that band's bias
    this.biasSrc.start();

    this.buildCrossover();
    this.buildBandStatics();
    for (let i = 0; i < B; i++) {
      this.buildBandEngine(i);
    }
    this.bandSum.connect(this.wet);
    this.applyDry();
    this.registerParams();
  }

  // Wire input → LR4 crossover tree → allpass phase-comp on the two outer bands → per-band TAP
  // (the point each band's own drive/bias/shaper chain attaches to). Built once; only the
  // crossover FREQUENCIES (and the linked allpass frequencies) ever retune afterward.
  private readonly tapNodes: AudioNode[] = [];
  private buildCrossover() {
    const ctx = this.ctx;
    const B = SaturatorFx.BANDS;
    const mkPair = (type: "lowpass" | "highpass", f: number): [BiquadFilterNode, BiquadFilterNode] => {
      const a = ctx.createBiquadFilter();
      const b = ctx.createBiquadFilter();
      for (const n of [a, b]) {
        n.type = type;
        n.frequency.value = f;
        n.Q.value = LR_Q;
      }
      a.connect(b);
      return [a, b];
    };
    const mkAllpassPair = (f: number): [BiquadFilterNode, BiquadFilterNode] => {
      const a = ctx.createBiquadFilter();
      const b = ctx.createBiquadFilter();
      for (const n of [a, b]) {
        n.type = "allpass";
        n.frequency.value = f;
        n.Q.value = XOVER_AP_QLIN;
      }
      a.connect(b);
      return [a, b];
    };

    for (let j = 0; j < B - 1; j++) this.xovers.push({ lp: mkPair("lowpass", extToHz(this._xfreqExt[j])), hp: mkPair("highpass", extToHz(this._xfreqExt[j])) });
    if (B > 2) {
      this.apLow = mkAllpassPair(extToHz(this._xfreqExt[B - 2])); // band0 ← the FAR crossover
      this.apHigh = mkAllpassPair(extToHz(this._xfreqExt[0])); // last band ← the FIRST crossover
    }
    for (let i = 0; i < B; i++) {
      let tap: AudioNode = this.input;
      if (i > 0) {
        this.input.connect(this.xovers[i - 1].hp[0]);
        tap = this.xovers[i - 1].hp[1];
      }
      if (i < B - 1) {
        tap.connect(this.xovers[i].lp[0]);
        tap = this.xovers[i].lp[1];
      }
      if (i === 0 && this.apLow) {
        tap.connect(this.apLow[0]);
        tap = this.apLow[1];
      }
      if (i === B - 1 && this.apHigh) {
        tap.connect(this.apHigh[0]);
        tap = this.apHigh[1];
      }
      this.tapNodes.push(tap);
    }
  }

  // The PERMANENT per-band nodes: drive (pre-gain), bias sum, DC blocker, voicing, automatic
  // makeup gain, then the user's OUT trim — two separate GainNodes on purpose (makeup chases the
  // curve/drive so perceived loudness stays put; OUT is the operator's own deliberate rebalance
  // on top, and must never be clobbered by makeup recomputing itself).
  // Only the nonlinearity between shaperIn and dc (buildBandEngine) ever gets torn down/rebuilt.
  private buildBandStatics() {
    const ctx = this.ctx;
    for (let i = 0; i < SaturatorFx.BANDS; i++) {
      const drive = ctx.createGain();
      drive.gain.value = driveGain(this._drive[i]);
      const shaperIn = ctx.createGain();
      const biasGain = ctx.createGain();
      biasGain.gain.value = this._bias[i] * 0.4;
      this.biasSrc.connect(biasGain).connect(shaperIn);
      drive.connect(shaperIn);
      // ★ The DC blocker and the VOICING filter are NOT built here — they belong to the engine,
      // because both are properties of the STYLE (voicing literally changes filter `type`, which
      // no AudioParam ramp can smooth) and both therefore have to live inside the crossfade.
      // buildBandEngine builds them; these arrays just hold whichever pair is current.
      const g = ctx.createGain();
      const outG = ctx.createGain();
      outG.gain.value = 1; // 0.5 ext = unity
      g.connect(outG).connect(this.bandSum);
      this.tapNodes[i].connect(drive);

      this.drives.push(drive);
      this.biasGains.push(biasGain);
      this.shaperIns.push(shaperIn);
      this.dcBlocks.push(null as unknown as BiquadFilterNode);
      this.voicings.push(null as unknown as BiquadFilterNode);
      this.aligns.push(null);
      this.bandGains.push(g);
      this.outGains.push(outG);
      this.shapers.push(null);
      this.tapeNodes.push(null);
    }
  }

  // (Re)build ONLY the nonlinearity stage (shaperIn → [WaveShaper | tape worklet] → dc[i]) —
  // torn down and rebuilt whenever that band's style changes to/from TAPE, mirroring ModFx's
  // buildEngine() mode-swap. Everything upstream (drive/bias) and downstream (dc/voicing/sum)
  // is permanent and untouched.
  // ★ A STYLE CHANGE CROSSFADES, IT DOES NOT CUT.
  // Swapping the nonlinearity used to sever the old node and connect the new one in the same
  // instant, so the band's output jumped from tape(x) to clip(x) between two samples — the
  // difference between two transfer functions, delivered as a step (fxlab --live-audit: the jump
  // leaving TAPE was 2.7× bigger than anything the material itself produces). The two curves are
  // fed the SAME input, so their outputs are coherent and a LINEAR fade is the correct one; each
  // engine gets its own gain node to fade, and the old one is only unhooked once it is silent.
  private static readonly ENGINE_FADE = 0.014;
  // ★ Chromium's `oversample: "4x"` WaveShaper costs 192 SAMPLES of group delay — its up/down
  // sampling FIRs — and it is 192 at 44.1k, 48k and 96k alike (fxlab --shaper-latency, measured
  // with an identity curve, essentially all of it causal). The TAPE worklet has none.
  //
  // That is not primarily a click. It means a band running TAPE sits 4 ms AHEAD of its two
  // neighbours, permanently, and the three bands sum out of time — comb filtering with notches
  // every ~250 Hz, on the exact feature this device exists for (TUBE lows with TAPE mids). The
  // style swap's ×2.7 jump was just the audible corner of it. The TAPE branch pays the same
  // delay back so every engine is time-aligned no matter which style each band holds.
  private static readonly SHAPER_LATENCY_SAMPLES = 192;
  private buildBandEngine(i: number, crossfade = false) {
    const ctx = this.ctx;
    const prevNode: AudioNode | null = this.tapeNodes[i] ?? this.shapers[i];
    const prevGain = this.engineGains[i] ?? null;
    const prevDc = this.dcBlocks[i] ?? null;
    const prevVoicing = this.voicings[i] ?? null;
    const prevAlign = this.aligns[i] ?? null;
    const fade = crossfade && !!prevNode && !!prevGain;
    if (!fade) {
      if (prevNode) safeDisconnect(prevNode);
      if (prevDc) safeDisconnect(prevDc);
      if (prevVoicing) safeDisconnect(prevVoicing);
      if (prevAlign) safeDisconnect(prevAlign);
      if (prevGain) safeDisconnect(prevGain);
      safeDisconnect(this.shaperIns[i]);
    }
    this.shapers[i] = null;
    this.tapeNodes[i] = null;

    const dc = ctx.createBiquadFilter();
    dc.type = "highpass";
    dc.frequency.value = DC_BLOCK_HZ;
    dc.Q.value = LR_Q;
    const voicing = ctx.createBiquadFilter();
    const g = ctx.createGain();
    g.gain.value = fade ? 0 : 1;
    dc.connect(voicing).connect(g).connect(this.bandGains[i]);
    let built = false;
    let align: DelayNode | null = null;
    if (this._style[i] === TAPE_STYLE) {
      try {
        const node = new AudioWorkletNode(ctx, "tape", { numberOfInputs: 1, numberOfOutputs: 1 });
        align = ctx.createDelay(0.05);
        align.delayTime.value = SaturatorFx.SHAPER_LATENCY_SAMPLES / ctx.sampleRate; // exact samples
        this.shaperIns[i].connect(node);
        node.connect(align).connect(dc);
        this.tapeNodes[i] = node;
        built = true;
      } catch (e) {
        console.warn("[htl] tape worklet unavailable, degrading band to native curve:", e);
      }
    }
    if (!built) {
      const shaper = ctx.createWaveShaper();
      shaper.oversample = "4x";
      this.shaperIns[i].connect(shaper).connect(dc);
      this.shapers[i] = shaper;
    }
    this.dcBlocks[i] = dc;
    this.voicings[i] = voicing;
    this.aligns[i] = align;
    this.engineGains[i] = g;
    this.applyVoicing(i); // the NEW engine starts already voiced — nothing to ramp mid-signal
    this.refreshBandNonlinearity(i);

    if (fade && prevNode && prevGain) {
      const F = SaturatorFx.ENGINE_FADE;
      const startFade = () => {
        const t = ctx.currentTime;
        prevGain.gain.cancelScheduledValues(t);
        prevGain.gain.setValueAtTime(prevGain.gain.value, t);
        prevGain.gain.linearRampToValueAtTime(0, t + F);
        g.gain.cancelScheduledValues(t);
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(1, t + F);
      };
      const tapeNode = this.tapeNodes[i];
      if (tapeNode) {
        // ★ WAIT FOR THE PROCESSOR. An AudioWorkletNode's processor is constructed
        // asynchronously on the audio thread; the node outputs silence until it exists, and that
        // took LONGER than the 14 ms fade — so the band went quiet, the fade finished, and the
        // engine snapped in at full gain afterwards (measured: the biggest step landed at exactly
        // +14 ms, the fade's end). Fading into a node that isn't running yet is not a crossfade.
        // The pong proves it's alive; the timer is the belt-and-braces path if it never answers.
        let started = false;
        const go = () => {
          if (started) return;
          started = true;
          startFade();
        };
        tapeNode.port.onmessage = (e) => {
          if ((e.data as { ready?: boolean }).ready) go();
        };
        tapeNode.port.postMessage({ ping: true });
        setTimeout(go, 150);
      } else {
        startFade();
      }
      // Unhook only once the old engine is fully faded — a worklet left connected keeps running,
      // and a node disconnected mid-fade is the very cut this exists to avoid.
      setTimeout(() => {
        safeDisconnect(prevNode);
        if (prevAlign) safeDisconnect(prevAlign);
        safeDisconnect(prevDc);
        safeDisconnect(prevVoicing);
        safeDisconnect(prevGain);
      }, F * 1000 + 260); // ≥ the ping timeout above, or the old engine is cut mid-fade
    }
  }

  // Re-apply whatever depends on style/punish/heat: the native curve (+its measured makeup) or
  // the worklet's `hot` (+its measured makeup). Called on style/punish/heat change — NOT on a
  // drive-only change, which applyDrive handles on its own (drive is a pre-gain the worklet
  // never needs to know about — see tapeWorklet.ts's header).
  private refreshBandNonlinearity(i: number) {
    const g = driveGain(this._drive[i]);
    const tape = this.tapeNodes[i];
    if (tape) {
      const hot = this.hotFor(i);
      tape.port.postMessage({ hot });
      this.bandGains[i].gain.setTargetAtTime(makeupForTape(hot, g), this.ctx.currentTime, 0.01);
    } else {
      const curve = this.curveForBand(i);
      const shaper = this.shapers[i];
      if (shaper) shaper.curve = curve;
      this.bandGains[i].gain.setTargetAtTime(makeupFor(curve, g), this.ctx.currentTime, 0.01);
    }
  }

  private curveForBand(i: number): Float32Array<ArrayBuffer> {
    return makeCurve(this._style[i], this.hotFor(i));
  }
  // PUNISH pushes a band's steepness up into [HEAT_MIN, HEAT_MAX] at THAT BAND's own HEAT
  // position; unpunished always stays at the fixed baseline regardless of HEAT.
  private hotFor(i: number): number {
    return this._punish[i] ? HEAT_MIN + this._heat[i] * (HEAT_MAX - HEAT_MIN) : HOT_BASE;
  }

  private applyVoicing(i: number) {
    const v = VOICING[this._style[i]] ?? VOICING[0];
    const voicing = this.voicings[i];
    voicing.type = v.type;
    voicing.frequency.setTargetAtTime(v.f, this.ctx.currentTime, 0.01);
    voicing.Q.value = v.q;
    voicing.gain.setTargetAtTime(v.g, this.ctx.currentTime, 0.02); // ramp → no click on style switch
  }

  // Dry leg = (1 − mix) when active, full when bypassed → a real insert crossfade (BaseFxDevice
  // keeps dry at unity for send effects; saturation must replace, not stack onto, the dry).
  private applyDry() {
    const dry = this.isBypassed ? 1 : 1 - this.mixAmount;
    this.dry.gain.setTargetAtTime(dry, this.ctx.currentTime, 0.01);
  }
  protected setMix(v: number) {
    super.setMix(v);
    this.applyDry();
  }
  setBypass(on: boolean) {
    super.setBypass(on);
    this.applyDry();
  }

  private applyDrive(i: number) {
    const g = driveGain(this._drive[i]);
    this.drives[i].gain.setTargetAtTime(g * this._throwBoost, this.ctx.currentTime, 0.01);
    // Measured makeup deliberately uses `g` WITHOUT throwBoost (see applyThrowBoost) — a throw
    // should hit louder, not be levelled straight back to neutral.
    const tape = this.tapeNodes[i];
    if (tape) {
      this.bandGains[i].gain.setTargetAtTime(makeupForTape(this.hotFor(i), g), this.ctx.currentTime, 0.01);
    } else {
      this.bandGains[i].gain.setTargetAtTime(makeupFor(this.curveForBand(i), g), this.ctx.currentTime, 0.01);
    }
  }
  private setStyle(i: number, v: number) {
    this._style[i] = clamp(Math.round(v), 0, SAT_STYLES.length - 1);
    this.buildBandEngine(i, true); // crossfade: this one happens with the signal running
  }
  private setPunish(i: number, on: boolean) {
    this._punish[i] = on;
    this.refreshBandNonlinearity(i);
  }
  private setHeat(i: number, v: number) {
    this._heat[i] = clamp01(v);
    this.refreshBandNonlinearity(i);
  }
  private setBias(i: number, ext: number) {
    this._bias[i] = clamp01(ext);
    this.biasGains[i].gain.setTargetAtTime(this._bias[i] * 0.4, this.ctx.currentTime, 0.01);
  }
  private setOut(i: number, ext: number) {
    this._out[i] = clamp01(ext);
    this.outGains[i].gain.setTargetAtTime(Math.pow(10, ((this._out[i] - 0.5) * 2 * 12) / 20), this.ctx.currentTime, 0.01); // ±12 dB
  }
  private setDrive(i: number, ext: number) {
    this._drive[i] = clamp01(ext);
    this.applyDrive(i);
  }
  private setXover(j: number, ext: number) {
    this._xfreqExt[j] = clamp01(ext);
    const f = extToHz(this._xfreqExt[j]);
    for (const n of [...this.xovers[j].lp, ...this.xovers[j].hp]) n.frequency.setTargetAtTime(f, this.ctx.currentTime, 0.02);
    // Cross-linked phase compensation (3-band-specific — see the header note): moving the FIRST
    // crossover retunes the LAST band's allpass; moving the LAST crossover retunes band0's.
    const B = SaturatorFx.BANDS;
    if (j === 0 && this.apHigh) for (const n of this.apHigh) n.frequency.setTargetAtTime(f, this.ctx.currentTime, 0.02);
    if (j === B - 2 && this.apLow) for (const n of this.apLow) n.frequency.setTargetAtTime(f, this.ctx.currentTime, 0.02);
  }

  /** Pad-throw TRIGGER: engage (un-bypass if dormant) + slam all band drives up while held;
   *  release restores the drives and re-bypasses if it was off. Mix is guaranteed audible by the
   *  base class (see BaseFxDevice.throwMix) — a slam with the wet turned down would otherwise
   *  light the pad up for nothing. */
  protected applyThrowBoost(on: boolean) {
    this._throwBoost = on ? 3 : 1;
    for (let i = 0; i < this.drives.length; i++) this.applyDrive(i);
  }

  /** Live reads for the WYSIWYG display: per-band style/curve/drive/bias/punish/heat/out + crossovers. */
  styleOf(i: number) {
    return this._style[i];
  }
  punishOf(i: number) {
    return this._punish[i];
  }
  biasOf(i: number) {
    return this._bias[i];
  }
  heatOf(i: number) {
    return this._heat[i];
  }
  outOf(i: number) {
    return this._out[i];
  }
  usesWorklet(i: number) {
    return !!this.tapeNodes[i];
  }
  /** The band's transfer curve for the UI preview — null when it's on the TAPE worklet (a
   *  stateful process has no single-valued input→output curve to draw). */
  curveFor(i: number): Float32Array | null {
    return this.usesWorklet(i) ? null : this.curveForBand(i);
  }
  driveOf(i: number) {
    return this._drive[i];
  }
  xoverHzOf(j: number) {
    return extToHz(this._xfreqExt[j]);
  }

  private registerParams() {
    const B = SaturatorFx.BANDS;
    for (let i = 0; i < B; i++) {
      this.params.push(
        { id: `style${i}`, def: 0, get: () => this._style[i], set: (v) => this.setStyle(i, v) },
        { id: `punish${i}`, def: 0, get: () => (this._punish[i] ? 1 : 0), set: (v) => this.setPunish(i, v >= 0.5) },
        { id: `bias${i}`, def: 0, get: () => this._bias[i], set: (v) => this.setBias(i, v) },
        { id: `heat${i}`, def: 0.5, get: () => this._heat[i], set: (v) => this.setHeat(i, v) },
        { id: `out${i}`, def: 0.5, get: () => this._out[i], set: (v) => this.setOut(i, v) },
        { id: `drive${i}`, def: 0.4, get: () => this._drive[i], set: (v) => this.setDrive(i, v) },
      );
    }
    for (let j = 0; j < B - 1; j++) this.params.push({ id: `xover${j}`, def: this._xfreqExt[j], get: () => this._xfreqExt[j], set: (v) => this.setXover(j, v) });
  }

  dispose() {
    try {
      this.biasSrc.stop();
    } catch {
      /* already stopped */
    }
    super.dispose();
  }
}
