// NOISE — a built-in riser / uplifter (the transition tool). Unlike the other devices this is
// a GENERATOR, not a processor: it doesn't filter the deck, it ADDS a swept noise layer on top
// (send-style, dry passes through untouched). A looping noise buffer (white / pink / + a tonal
// element) runs through a RESONANT sweep HIGH-PASS (the rise) and a post TONE low-pass, gated by
// a rise envelope. NATIVE Web Audio (noise gen is trivial: a buffer source + two biquads).
//
//   input ──────────────────────────────→ dry ─────────────→ output   (untouched)
//   noiseBuf ┐                                                  ▲
//   tonalOsc ┴→ preMix → sweep(HP,res) → tone(LP) → riseGain ─→ wet ─(mix)→ output
//
// The riseGain is the ENGAGE envelope (0 = silent). Two ways to engage (the pad-throw):
//   • MANUAL  — gate on at the current SWEEP; ride SWEEP/RES by hand while held.
//   • RISE    — auto-build: cutoff + level ramp UP over BARS bars (tempo-synced); release = cut.
// SWEEP/RES are always live AudioParam ramps; the viz reads the real filter response.
import { BaseFxDevice, type FxKind } from "./Fx";

export const NOISE_TYPES = ["WHITE", "PINK", "TONAL"] as const;
export type NoiseType = (typeof NOISE_TYPES)[number];

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const sweepHzOf = (ext: number) => 60 * Math.pow(16000 / 60, clamp01(ext)); // 60 Hz‥16 kHz log
const toneHzOf = (ext: number) => 600 * Math.pow(20000 / 600, clamp01(ext)); // 600 Hz‥20 kHz log

// White + pink (Paul Kellet's economy filter) noise into a ~2 s looping buffer.
function makeNoiseBuffer(ctx: AudioContext, pink: boolean): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * 2);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  let b3 = 0;
  let b4 = 0;
  let b5 = 0;
  let b6 = 0;
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1;
    if (!pink) {
      d[i] = w;
      continue;
    }
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
    b6 = w * 0.115926;
  }
  return buf;
}

export class NoiseFx extends BaseFxDevice {
  readonly kind: FxKind = "noise";

  private readonly white: AudioBuffer;
  private readonly pink: AudioBuffer;
  private noise: AudioBufferSourceNode;
  private readonly preMix: GainNode; // noise + tonal merge into the sweep
  private readonly tonalOsc: OscillatorNode;
  private readonly tonalGain: GainNode;
  private readonly sweep: BiquadFilterNode; // resonant high-pass = the rise
  private readonly tone: BiquadFilterNode; // post low-pass = dark↔bright
  private readonly riseGain: GainNode; // engage envelope (0 = silent)

  private _type = 0;
  private _sweep = 0.3; // 0..1 manual cutoff position
  private _res = 0.4; // 0..1 → Q
  private _tone = 0.8; // 0..1 → post LP (bright)
  private _rise = true; // auto-build mode (vs manual gate)
  private _bars = 4; // auto-build length
  private _bpm = 120;
  private _throw = false;

  // scratch for the viz's frequency-response read
  private _scMag: Float32Array<ArrayBuffer> | null = null;
  private _scPh: Float32Array<ArrayBuffer> | null = null;

  constructor(ctx: AudioContext) {
    super(ctx, 0.5); // send-style: dry stays at unity, noise adds on top
    this.white = makeNoiseBuffer(ctx, false);
    this.pink = makeNoiseBuffer(ctx, true);
    this.preMix = ctx.createGain();
    this.sweep = ctx.createBiquadFilter();
    this.sweep.type = "highpass";
    this.tone = ctx.createBiquadFilter();
    this.tone.type = "lowpass";
    this.riseGain = ctx.createGain();
    this.riseGain.gain.value = 0;
    this.tonalGain = ctx.createGain();
    this.tonalGain.gain.value = 0;
    this.tonalOsc = ctx.createOscillator();
    this.tonalOsc.type = "sawtooth";

    this.noise = this.startNoise();
    this.tonalOsc.connect(this.tonalGain).connect(this.preMix);
    this.preMix.connect(this.sweep).connect(this.tone).connect(this.riseGain).connect(this.wet);
    this.tonalOsc.start();

    this.applySweep();
    this.applyRes();
    this.applyTone();
    this.registerParams();
  }

  private startNoise(): AudioBufferSourceNode {
    const n = this.ctx.createBufferSource();
    n.buffer = this._type === 1 || this._type === 2 ? this.pink : this.white;
    n.loop = true;
    n.connect(this.preMix);
    n.start();
    return n;
  }

  private applySweep() {
    this.sweep.frequency.setTargetAtTime(sweepHzOf(this._sweep), this.ctx.currentTime, 0.01);
    if (this._type === 2) this.tonalOsc.frequency.setTargetAtTime(sweepHzOf(this._sweep) * 0.5, this.ctx.currentTime, 0.01);
  }
  private applyRes() {
    this.sweep.Q.setTargetAtTime(0.7 + clamp01(this._res) * 22, this.ctx.currentTime, 0.02);
  }
  private applyTone() {
    this.tone.frequency.setTargetAtTime(toneHzOf(this._tone), this.ctx.currentTime, 0.02);
  }

  private setType(v: number) {
    this._type = clamp(Math.round(v), 0, NOISE_TYPES.length - 1);
    // swap the noise buffer (a source can't change buffer after start → respawn)
    try {
      this.noise.stop();
      this.noise.disconnect();
    } catch {
      /* ignore */
    }
    this.noise = this.startNoise();
    this.tonalGain.gain.setTargetAtTime(this._type === 2 ? 0.16 : 0, this.ctx.currentTime, 0.02);
    if (this._type === 2) this.applySweep();
  }
  private setSweep(v: number) {
    this._sweep = clamp01(v);
    if (!this._isRising()) this.applySweep();
  }
  private setRes(v: number) {
    this._res = clamp01(v);
    this.applyRes();
  }
  private setTone(v: number) {
    this._tone = clamp01(v);
    this.applyTone();
  }
  private setRise(on: boolean) {
    this._rise = on;
  }
  private setBars(v: number) {
    this._bars = clamp(Math.round(v), 1, 8);
  }

  /** Panel feeds the deck's live BPM so an auto-build's length tracks the tempo. */
  setSyncBpm(bpm: number) {
    if (bpm > 0) this._bpm = bpm;
  }

  private _riseEnd = 0;
  private _isRising() {
    return this._throw && this._rise && this.ctx.currentTime < this._riseEnd;
  }

  /** Pad-throw / engage. RISE mode → tempo-synced auto-build; else a manual gate at SWEEP. */
  setThrow(on: boolean) {
    this._throw = on;
    const t = this.ctx.currentTime;
    const g = this.riseGain.gain;
    const f = this.sweep.frequency;
    g.cancelScheduledValues(t);
    f.cancelScheduledValues(t);
    if (on) {
      if (this._rise) {
        const barSec = (60 / this._bpm) * 4;
        const dur = Math.max(0.25, this._bars * barSec);
        this._riseEnd = t + dur;
        // cutoff climbs 80 Hz → ~12 kHz; level swells 0 → 1 over the build.
        f.setValueAtTime(80, t);
        f.exponentialRampToValueAtTime(12000, t + dur);
        g.setValueAtTime(Math.max(0.0001, g.value), t);
        g.linearRampToValueAtTime(1, t + dur);
        if (this._type === 2) {
          this.tonalOsc.frequency.cancelScheduledValues(t);
          this.tonalOsc.frequency.setValueAtTime(80, t);
          this.tonalOsc.frequency.exponentialRampToValueAtTime(3000, t + dur);
        }
      } else {
        this._riseEnd = 0;
        this.applySweep();
        g.setTargetAtTime(1, t, 0.015); // quick gate on
      }
    } else {
      this._riseEnd = 0;
      g.setTargetAtTime(0, t, 0.03); // the drop — cut to silence
    }
  }
  get throwing() {
    return this._throw;
  }

  // ---- live reads for the WYSIWYG -----------------------------------------
  get typeIndex() {
    return this._type;
  }
  get rising() {
    return this._rise;
  }
  get sweepHz() {
    return this.sweep.frequency.value;
  }
  get engaged() {
    return this._throw;
  }
  /** Fill `out` with the combined sweep×tone magnitude response at `freqs` (for the viz curve). */
  getResponse(freqs: Float32Array<ArrayBuffer>, out: Float32Array<ArrayBuffer>) {
    if (!this._scMag || this._scMag.length !== freqs.length) {
      this._scMag = new Float32Array(freqs.length);
      this._scPh = new Float32Array(freqs.length);
    }
    const ph = this._scPh as Float32Array<ArrayBuffer>;
    const m2 = this._scMag as Float32Array<ArrayBuffer>;
    this.sweep.getFrequencyResponse(freqs, out, ph);
    this.tone.getFrequencyResponse(freqs, m2, ph);
    for (let i = 0; i < out.length; i++) out[i] *= m2[i];
  }

  private registerParams() {
    this.params.push(
      { id: "type", def: 0, get: () => this._type, set: (v) => this.setType(v) },
      { id: "sweep", def: 0.3, get: () => this._sweep, set: (v) => this.setSweep(v) },
      { id: "res", def: 0.4, get: () => this._res, set: (v) => this.setRes(v) },
      { id: "tone", def: 0.8, get: () => this._tone, set: (v) => this.setTone(v) },
      { id: "rise", def: 1, get: () => (this._rise ? 1 : 0), set: (v) => this.setRise(v >= 0.5) },
      { id: "bars", def: 4, get: () => this._bars, set: (v) => this.setBars(v) },
    );
  }

  dispose() {
    try {
      this.noise.stop();
    } catch {
      /* ignore */
    }
    try {
      this.tonalOsc.stop();
    } catch {
      /* ignore */
    }
    super.dispose();
  }
}
