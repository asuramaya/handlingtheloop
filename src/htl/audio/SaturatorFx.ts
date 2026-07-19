// Multiband saturator — Decapitator flavor under Saturn glass. NATIVE Web Audio (no
// worklet): a Linkwitz-Riley crossover splits the signal into N bands, each driven into a
// `WaveShaperNode` (4x oversampled — the browser anti-aliases) carrying the selected style
// curve, DC-blocked, and summed. A true INSERT (dry/wet crossfade, not a send-add), so at
// mix=1 you hear only the saturated signal. Free when bypassed via BaseFxDevice's wet gate.
//
//   input ─┬─→ dry·(1−mix) ─────────────────────────────────────────────────────→ output
//          └─→ [LR4 split] → band i: drive → (+bias DC) → shaper(4x) → dcBlock → gain ─┐
//                                                                          sum → tone → out → wet
//
// Drive is a PRE-GAIN node (real-time), so curves regenerate ONLY on style/punish change.
// Bias is a DC offset summed before the shaper (asymmetry → even harmonics) and removed by
// the per-band DC blocker. The band count + crossover tree are built in a loop, so widening
// to 2 or 4 bands is a constant change, not a rewrite.
import { BaseFxDevice, type FxKind } from "./Fx";
import { clamp, clamp01, logMap } from "./fxDsp";

export const SAT_STYLES = ["TUBE", "TAPE", "CLIP", "FOLD", "DIODE"] as const;
export type SatStyle = (typeof SAT_STYLES)[number];

const CURVE_LEN = 2048;
const DC_BLOCK_HZ = 12;
// ★ Web Audio reads Q in DECIBELS for lowpass/highpass (alpha = sin(w0)/(2·10^(Q/20))), so the
// old `0.7071` here was not Butterworth — it was 0.7071 dB of resonance (linear Q ≈ 1.085, a
// +1.7 dB peak at each corner). The whole point of Linkwitz-Riley is that the bands SUM FLAT, and
// they didn't: the split coloured the signal by ~+0.7 dB broadband before a single band was driven.
// −3.01 dB IS Butterworth (10^(−3.01/20) = 0.7071); two cascaded = LR4, which sums flat.
const LR_Q = -3.01;

// 0..1 knob → pre-gain into the curve: −10 dB … +20 dB.
// It starts BELOW unity on purpose. A WaveShaper's domain is [−1,1], so the curve has to do all its
// bending inside that window — which means a pre-gain of 1.0 parks a mastered, full-scale track
// right ON the knee, and the "drive" knob is already saturating at zero. Starting at −10 dB puts a
// hot input in the curve's LINEAR region, so drive 0 is genuinely transparent and the knob walks the
// signal up into the bend. makeupFor() takes the 10 dB back out, so the level doesn't move.
const driveGain = (ext: number) => Math.pow(10, (clamp01(ext) * 30 - 10) / 20);
// 0..1 → log frequency 20 Hz‥20 kHz (crossover points).
const extToHz = logMap(20, 20000);
const hzToExt = (hz: number) => Math.log(clamp(hz, 20, 20000) / 20) / Math.log(1000);

// Per-style transfer function over x∈[-1,1]. WaveShaperNode clamps its INPUT to [-1,1] then
// looks up the curve, so drive (pre-gain) pushes the signal toward the saturated/folded
// edges. FOLD bakes the fold into the domain since pre-gain can't push past the clamp.
function makeCurve(style: number, punish: boolean): Float32Array<ArrayBuffer> {
  const c = new Float32Array(CURVE_LEN);
  const hot = punish ? 2.2 : 1.4; // steepness into the nonlinear region
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
      case 1: // TAPE — gentle soft-knee compression that never fully clips → low-order, smooth
        // (lots of headroom; the dirt comes up slowly). Voiced dark below.
        y = k / (1 + 0.6 * Math.abs(k));
        break;
      case 2: // CLIP — near-HARD clip (a thin cubic knee then flat) → strong ODD harmonics,
        // buzzy/transistor. Deliberately the opposite of TUBE/TAPE's soft round.
        y = k <= -1 ? -1 : k >= 1 ? 1 : 1.5 * k - 0.5 * k * k * k;
        break;
      case 3: // FOLD — sine wavefolder; peaks then folds back on itself → inharmonic, metallic
        y = Math.sin(k * Math.PI * (punish ? 1.3 : 0.95));
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

// ★ UNITY SMALL-SIGNAL SLOPE. Every curve above was EXPANSIVE near zero — `hot` (1.4) scales the
// input and then each curve adds its own slope on top (TUBE's tanh(1.5k) → 2.1×, FOLD's sine →
// 4.2×). So with the drive knob at ZERO the saturator still added +7 dB and squashed 6 dB of range:
// a compressor nobody asked for, flattering itself the oldest way in audio — louder reads as better.
// A saturator must be TRANSPARENT at zero drive and bend only as it's pushed, so each curve is
// divided by its own slope at the origin. (Same fix as the delay's analog drive: a >1 small-signal
// gain is never what you meant.) The peak is deliberately NOT renormalised afterwards — the curve is
// supposed to saturate below full scale, and makeupFor() pays the loudness back.
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

// ★ REAL AUTO-MAKEUP. The old comp was `1 / driveGain` — the inverse of the PRE-gain, which knows
// nothing about what the curve then does. At drive 0 that is 1/1, i.e. no compensation at all (while
// the curve was quietly adding 7 dB), and under heavy drive it over-corrects, because a saturated
// signal is nowhere near input×drive. So MEASURE it: push a reference tone through the ACTUAL curve
// at the ACTUAL drive, take its RMS, compensate by exactly that. DC is removed first because the
// per-band DC blocker removes it downstream too (TUBE's even-harmonic k² term would otherwise
// inflate the reading). Now DRIVE changes character, not loudness — the only way an A/B of the drive
// knob tells you the truth.
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

interface Xover {
  lp: [BiquadFilterNode, BiquadFilterNode]; // LR4 lowpass pair (feeds the band below)
  hp: [BiquadFilterNode, BiquadFilterNode]; // LR4 highpass pair (feeds the band above)
}

// Per-style baked tonal VOICING (one post filter) — the Decapitator-model trick: the curve
// gives the harmonics, the voicing gives each model its EQ identity (tape dark, transistor
// bright, the asymmetric ones honk). Separate from the user TONE knob, applied at the sum.
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

  private readonly drives: GainNode[] = [];
  private readonly shapers: WaveShaperNode[] = [];
  private readonly bandGains: GainNode[] = [];
  private readonly xovers: Xover[] = []; // BANDS-1 crossovers (retunable)
  private readonly bias: ConstantSourceNode;
  private readonly voicing: BiquadFilterNode; // per-style baked EQ identity
  private readonly tone: BiquadFilterNode; // post tilt (high-shelf), user TONE
  private readonly outTrim: GainNode;
  private readonly bandSum: GainNode;

  private _style = 0;
  private _punish = false;
  private _bias = 0; // 0..1
  private _toneExt = 0.5; // 0..1 (0.5 = flat)
  private _outExt = 0.5; // 0..1 (0.5 = unity)
  private readonly _drive: number[]; // 0..1 per band
  private readonly _xfreqExt: number[]; // 0..1 per crossover
  private _throwBoost = 1; // pad-throw multiplier into all band drives

  constructor(ctx: AudioContext) {
    super(ctx, 1.0); // insert: full wet by default
    const B = SaturatorFx.BANDS;
    this._drive = new Array(B).fill(0.4);
    this._xfreqExt = [hzToExt(250), hzToExt(2500)].slice(0, B - 1);

    this.bandSum = ctx.createGain();
    this.bias = ctx.createConstantSource();
    this.bias.offset.value = 0;
    this.bias.start();
    this.voicing = ctx.createBiquadFilter();
    this.tone = ctx.createBiquadFilter();
    this.tone.type = "highshelf";
    this.tone.frequency.value = 3000;
    this.tone.gain.value = 0;
    this.outTrim = ctx.createGain();
    this.outTrim.gain.value = 1;

    this.buildBands();
    this.bandSum.connect(this.voicing).connect(this.tone).connect(this.outTrim).connect(this.wet);
    this.applyDry();
    this.registerParams();
    this.refreshCurves();
    this.applyVoicing();
  }

  // Build the per-band shaper chains + the LR4 crossover tree (input → splits → drives).
  private buildBands() {
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

    for (let i = 0; i < B; i++) {
      const drive = ctx.createGain();
      drive.gain.value = driveGain(this._drive[i]);
      const shaperIn = ctx.createGain();
      const shaper = ctx.createWaveShaper();
      shaper.oversample = "4x";
      const dc = ctx.createBiquadFilter();
      dc.type = "highpass";
      dc.frequency.value = DC_BLOCK_HZ;
      dc.Q.value = LR_Q;
      const g = ctx.createGain();
      g.gain.value = makeupFor(this._curve, driveGain(this._drive[i])); // measured makeup (see applyDrive)
      drive.connect(shaperIn);
      this.bias.connect(shaperIn); // global DC bias → asymmetry, removed by dc below
      shaperIn.connect(shaper).connect(dc).connect(g).connect(this.bandSum);
      this.drives.push(drive);
      this.shapers.push(shaper);
      this.bandGains.push(g);
    }

    // Crossover routing: band 0 = LP(x0); band i = HP(x[i-1])→LP(x[i]); band N-1 = HP(x[N-2]).
    for (let j = 0; j < B - 1; j++) {
      this.xovers.push({ lp: mkPair("lowpass", extToHz(this._xfreqExt[j])), hp: mkPair("highpass", extToHz(this._xfreqExt[j])) });
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
      tap.connect(this.drives[i]);
    }
  }

  private _curve: Float32Array<ArrayBuffer> = makeCurve(0, false); // the LIVE curve — makeup is measured against it
  private refreshCurves() {
    this._curve = makeCurve(this._style, this._punish);
    for (const s of this.shapers) s.curve = this._curve; // global style → all bands share the curve
    for (let i = 0; i < this.drives.length; i++) this.applyDrive(i); // makeup depends on the CURVE, not just the drive
  }
  private applyVoicing() {
    const v = VOICING[this._style] ?? VOICING[0];
    this.voicing.type = v.type;
    this.voicing.frequency.setTargetAtTime(v.f, this.ctx.currentTime, 0.01);
    this.voicing.Q.value = v.q;
    this.voicing.gain.setTargetAtTime(v.g, this.ctx.currentTime, 0.02); // ramp → no click on style switch
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
    // AUTO GAIN-COMP, measured (see makeupFor): push a reference tone through the actual curve at
    // this drive and compensate by the RMS it actually comes back with — so cranking drive pushes
    // the signal harder INTO the curve (more saturation) at a constant level. Dirt, not loudness.
    // That is what makes MIX a perceptually even dry↔wet blend, and what lets you A/B the drive
    // knob honestly. The throwBoost is deliberately left uncompensated (a pad throw should hit
    // harder AND a touch louder); OUT trims the rest.
    this.bandGains[i].gain.setTargetAtTime(makeupFor(this._curve, g), this.ctx.currentTime, 0.01);
  }
  private setStyle(v: number) {
    this._style = clamp(Math.round(v), 0, SAT_STYLES.length - 1);
    this.refreshCurves();
    this.applyVoicing();
  }
  private setPunish(on: boolean) {
    this._punish = on;
    this.refreshCurves();
  }
  private setBias(ext: number) {
    this._bias = clamp01(ext);
    this.bias.offset.setTargetAtTime(this._bias * 0.4, this.ctx.currentTime, 0.01);
  }
  private setTone(ext: number) {
    this._toneExt = clamp01(ext);
    this.tone.gain.setTargetAtTime((this._toneExt - 0.5) * 2 * 12, this.ctx.currentTime, 0.01); // ±12 dB
  }
  private setOut(ext: number) {
    this._outExt = clamp01(ext);
    this.outTrim.gain.setTargetAtTime(Math.pow(10, ((this._outExt - 0.5) * 2 * 12) / 20), this.ctx.currentTime, 0.01);
  }
  private setDrive(i: number, ext: number) {
    this._drive[i] = clamp01(ext);
    this.applyDrive(i);
  }
  private setXover(j: number, ext: number) {
    this._xfreqExt[j] = clamp01(ext);
    const f = extToHz(this._xfreqExt[j]);
    for (const n of [...this.xovers[j].lp, ...this.xovers[j].hp]) n.frequency.setTargetAtTime(f, this.ctx.currentTime, 0.02);
  }

  /** Pad-throw TRIGGER: engage (un-bypass if dormant) + slam all band drives up while held;
   *  release restores the drives and re-bypasses if it was off. Mix is guaranteed audible by the
   *  base class (see BaseFxDevice.throwMix) — a slam with the wet turned down would otherwise
   *  light the pad up for nothing. */
  protected applyThrowBoost(on: boolean) {
    this._throwBoost = on ? 3 : 1;
    for (let i = 0; i < this.drives.length; i++) this.applyDrive(i);
  }

  /** Live read for the WYSIWYG display: the style curve + per-band drive/crossover state. */
  get styleIndex() {
    return this._style;
  }
  curveFor(): Float32Array {
    return makeCurve(this._style, this._punish);
  }
  driveOf(i: number) {
    return this._drive[i];
  }
  xoverHzOf(j: number) {
    return extToHz(this._xfreqExt[j]);
  }

  private registerParams() {
    this.params.push(
      { id: "style", def: 0, get: () => this._style, set: (v) => this.setStyle(v) },
      { id: "punish", def: 0, get: () => (this._punish ? 1 : 0), set: (v) => this.setPunish(v >= 0.5) },
      { id: "bias", def: 0, get: () => this._bias, set: (v) => this.setBias(v) },
      { id: "tone", def: 0.5, get: () => this._toneExt, set: (v) => this.setTone(v) },
      { id: "out", def: 0.5, get: () => this._outExt, set: (v) => this.setOut(v) },
    );
    for (let i = 0; i < SaturatorFx.BANDS; i++) this.params.push({ id: `drive${i}`, def: 0.4, get: () => this._drive[i], set: (v) => this.setDrive(i, v) });
    for (let j = 0; j < SaturatorFx.BANDS - 1; j++) this.params.push({ id: `xover${j}`, def: this._xfreqExt[j], get: () => this._xfreqExt[j], set: (v) => this.setXover(j, v) });
  }

  dispose() {
    try {
      this.bias.stop();
    } catch {
      /* already stopped */
    }
    super.dispose();
  }
}
