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
//   • RISE    — auto-build: cutoff + level travel over BARS bars (tempo-synced); release = cut.
// SWEEP/RES are always live AudioParam ramps; the viz reads the real filter response.
//
// ★ IT LANDS ON THE ONE. The build used to start at ctx.currentTime and run BARS bars from
// THERE: tempo-synced in LENGTH and completely unanchored in POSITION, so an 8-bar riser ended
// wherever your finger happened to press. A riser's entire job is to arrive on the downbeat.
// SNAP quantises the build's END to the deck's bar grid — the same grid the waveform draws, via
// Deck.barGridCtx() — stretching or compressing the ramp by up to half a bar to fit. Press
// whenever; it lands on the drop.
//
// ★ AND IT FALLS. DIR flips the sweep: UP is the riser, DOWN is the downlifter that goes with
// the drop instead of before it. Same envelope machinery, run backwards.
//
// The whole envelope is a SAMPLED CURVE (setValueCurveAtTime) rather than a pair of fixed
// ramps, which is what lets CURVE reshape the build's feel — late bloom through linear to
// front-loaded — and lets direction be a one-line reversal instead of a second code path.
import { BaseFxDevice, type FxKind } from "./Fx";
import { clamp, clamp01, logMap } from "./fxDsp";

export const NOISE_TYPES = ["WHITE", "PINK", "TONAL"] as const;
export type NoiseType = (typeof NOISE_TYPES)[number];

const sweepHzOf = logMap(60, 16000); // 60 Hz‥16 kHz log
const toneHzOf = logMap(600, 20000); // 600 Hz‥20 kHz log
const SWEEP_LO = 80; // the build's ends, in Hz
const SWEEP_HI = 12000;
const ENV_POINTS = 256; // resolution of the sampled build curve (linear between points)

export const NOISE_DIRS = ["UP", "DOWN"] as const;

/**
 * The build's shape. `p` is linear progress 0‥1; `curve` 0‥1 bends it — 0.5 is linear, below is
 * a LATE BLOOM (holds back, then rushes), above is FRONT-LOADED (leaps, then eases in).
 *
 * A riser's whole character is this curve. Two fixed ramps (exponential on frequency, linear on
 * level) gave the device exactly one build, and every riser it made sounded like the same event.
 */
/**
 * Stop whatever automation is running on a param and hold it where it is, then clear the future.
 * `cancelScheduledValues` alone does NOT stop a setValueCurveAtTime that is already in flight —
 * the curve keeps playing to its end — so a release mid-build would have fought the build.
 */
function holdAndCancel(p: AudioParam, t: number) {
  const anyP = p as AudioParam & { cancelAndHoldAtTime?: (t: number) => void };
  if (typeof anyP.cancelAndHoldAtTime === "function") anyP.cancelAndHoldAtTime(t);
  else {
    const v = p.value;
    p.cancelScheduledValues(t);
    p.setValueAtTime(v, t);
  }
}

/**
 * How long a build starting at `t` should run so that it ENDS on a bar line.
 *
 * Pure, and exported, because it is the whole of SNAP and the one part testable without an
 * AudioContext (the rendered proof is not available: BaseFxDevice.throwMix floors the wet during
 * a throw, so the device's own noise is always in the output and no envelope read can isolate the
 * build's end from it — see the removed --noise-snap probe).
 *
 * The end is quantised to the NEAREST bar line, so the duration moves by at most half a bar in
 * either direction — a riser that lands is worth half a bar of stretch. `minSec` stops the
 * quantiser collapsing a build into a click when the nearest line is nearly underfoot.
 */
export function noiseBuildEnd(t: number, nominal: number, grid: { at: number; bar: number } | null, minSec: number): number {
  if (!grid || !(grid.bar > 0)) return nominal;
  const k = Math.round((t + nominal - grid.at) / grid.bar);
  return Math.max(minSec, grid.at + k * grid.bar - t);
}

export function noiseEase(p: number, curve: number): number {
  const gamma = Math.pow(2, (0.5 - clamp01(curve)) * 2.5); // 0.42 (front-loaded) ‥ 2.38 (late)
  return Math.pow(clamp01(p), gamma);
}

// White + pink (Paul Kellet's economy filter) noise into a ~2 s looping buffer.
// TWO channels of INDEPENDENT noise, not one duplicated. Independence is what stereo width is
// made of — a mono noise layer sits in the middle of the mix and no amount of panning widens it,
// because both ears get the identical waveform. The device blends between the two (see setWidth),
// so width 0 is genuinely mono-safe and width 1 is fully decorrelated.
function makeNoiseBuffer(ctx: AudioContext, pink: boolean): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * 2);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) fillNoise(buf.getChannelData(ch), pink);
  return buf;
}

function fillNoise(d: Float32Array, pink: boolean) {
  const len = d.length;
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
}

export class NoiseFx extends BaseFxDevice {
  readonly kind: FxKind = "noise";

  private readonly white: AudioBuffer;
  private readonly pink: AudioBuffer;
  private noise: AudioBufferSourceNode;
  private readonly preMix: GainNode; // noise + tonal merge into the sweep
  private readonly split: ChannelSplitterNode; // the noise buffer's two INDEPENDENT channels
  private readonly merge: ChannelMergerNode;
  private readonly wideMono: GainNode; // right channel fed from the LEFT noise  (width 0)
  private readonly wideSide: GainNode; // …and from the second, independent one   (width 1)
  private readonly duckGain: GainNode; // the dry, pulled down under a build
  private readonly impactBus: GainNode; // one-shot hit on release, past the rise envelope
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
  private _dir = 0; // 0 = UP (riser), 1 = DOWN (downlifter)
  private _curve = 0.5; // build shape — see noiseEase
  private _snap = true; // quantise the build's END to the bar grid
  private _width = 0; // stereo decorrelation of the noise layer
  private _duck = 0; // how far the DRY is pulled down under the build
  private _impact = 0; // the hit on release
  private _keyHz = 0; // the track's tonic, when known (TONAL follows it)
  private grid: { at: number; bar: number } | null = null;

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

    // Stereo path: the buffer's two independent channels are split, and the RIGHT output is a
    // blend of them — left's copy at width 0, its own at width 1 (see setWidth).
    this.split = ctx.createChannelSplitter(2);
    this.merge = ctx.createChannelMerger(2);
    this.wideMono = ctx.createGain();
    this.wideSide = ctx.createGain();
    this.wideMono.gain.value = 1;
    this.wideSide.gain.value = 0;
    this.split.connect(this.merge, 0, 0); // L ← channel 0, always
    this.split.connect(this.wideMono, 0).connect(this.merge, 0, 1);
    this.split.connect(this.wideSide, 1).connect(this.merge, 0, 1);
    this.merge.connect(this.preMix);

    this.noise = this.startNoise();
    this.tonalOsc.connect(this.tonalGain).connect(this.preMix);
    this.preMix.connect(this.sweep).connect(this.tone).connect(this.riseGain).connect(this.wet);
    this.tonalOsc.start();

    // DUCK — the device is send-style, so the music passes through `dry` untouched; splicing our
    // own gain into that leg lets a build pull the track down under itself (the move a DJ makes by
    // hand on the fader) without touching the base class's mix handling. Same re-route ModFx uses
    // for its through-zero dry delay.
    this.duckGain = ctx.createGain();
    try {
      this.input.disconnect(this.dry);
    } catch {
      /* first build */
    }
    this.input.connect(this.duckGain).connect(this.dry);

    // The release IMPACT joins at the wet, PAST the rise envelope — the envelope is on its way to
    // zero at exactly the moment the hit needs to sound.
    this.impactBus = ctx.createGain();
    this.impactBus.connect(this.wet);

    this.applySweep();
    this.applyRes();
    this.applyTone();
    this.registerParams();
  }

  private startNoise(): AudioBufferSourceNode {
    const n = this.ctx.createBufferSource();
    n.buffer = this._type === 1 || this._type === 2 ? this.pink : this.white;
    n.loop = true;
    n.connect(this.split);
    n.start();
    return n;
  }

  private applySweep() {
    this.sweep.frequency.setTargetAtTime(sweepHzOf(this._sweep), this.ctx.currentTime, 0.01);
    if (this._type === 2) this.tonalOsc.frequency.setTargetAtTime(sweepHzOf(this._sweep) * 0.5, this.ctx.currentTime, 0.01);
  }
  private applyRes() {
    this.sweep.Q.setTargetAtTime(-3.01 + clamp01(this._res) * 25, this.ctx.currentTime, 0.02); // Q is in dB for a highpass: −3.01 = flat, up = resonant
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
  private setDir(v: number) {
    this._dir = clamp(Math.round(v), 0, NOISE_DIRS.length - 1);
  }
  private setCurve(v: number) {
    this._curve = clamp01(v);
  }
  private setSnap(on: boolean) {
    this._snap = on;
  }
  /**
   * Stereo WIDTH — how much of the RIGHT channel comes from the second, independent noise stream
   * rather than a copy of the left. 0 is bit-identical channels (mono-safe); 1 is fully
   * decorrelated, which is as wide as noise gets.
   */
  private setWidth(v: number) {
    this._width = clamp01(v);
    const t = this.ctx.currentTime;
    // Equal-POWER between the two, or the layer gets quieter in the middle of the knob: the two
    // streams are uncorrelated, so their powers add rather than their amplitudes.
    this.wideMono.gain.setTargetAtTime(Math.cos((this._width * Math.PI) / 2), t, 0.02);
    this.wideSide.gain.setTargetAtTime(Math.sin((this._width * Math.PI) / 2), t, 0.02);
  }
  private setDuck(v: number) {
    this._duck = clamp01(v);
  }
  private setImpact(v: number) {
    this._impact = clamp01(v);
  }

  /**
   * The deck's bar grid in ctx time (Deck.barGridCtx) — the SAME grid the waveform draws, so a
   * snapped build lands on a line the human can see. Null = nothing to snap to; the build runs
   * its nominal length.
   */
  setGrid(ref: { at: number; bar: number } | null) {
    this.grid = ref && ref.bar > 0 ? { at: ref.at, bar: ref.bar } : null;
  }

  /** The track's tonic in Hz, so TONAL can belong to the record instead of sweeping through it. */
  setKeyHz(hz: number) {
    this._keyHz = hz > 0 ? hz : 0;
  }

  /** Panel feeds the deck's live BPM so an auto-build's length tracks the tempo. */
  setSyncBpm(bpm: number) {
    if (bpm > 0) this._bpm = bpm;
  }

  private _riseStart = 0;
  private _riseEnd = 0;
  private _isRising() {
    return this.throwing && this._rise && this.ctx.currentTime < this._riseEnd;
  }
  /** Auto-build progress 0..1 while a tempo-synced rise is in flight, else −1 (for the viz). */
  get riseProgress(): number {
    if (!this._isRising()) return -1;
    const span = this._riseEnd - this._riseStart;
    return span > 0 ? clamp01((this.ctx.currentTime - this._riseStart) / span) : 0;
  }
  /** The auto-build length in bars (1..8). */
  get bars(): number {
    return this._bars;
  }
  get dirIndex(): number {
    return this._dir;
  }
  get snapped(): boolean {
    return this._snap;
  }
  /** True when SNAP has a grid to actually snap to — the readout must not claim it otherwise. */
  get hasGrid(): boolean {
    return !!this.grid;
  }
  /** True when TONAL is tracking a real detected key rather than its fallback span. */
  get keyLocked(): boolean {
    return this._type === 2 && this._keyHz > 0;
  }

  /** Pad-throw TRIGGER. Engages the device (un-bypass if dormant); RISE mode → tempo-synced
   *  auto-build, else a manual gate at SWEEP. Release cuts it + re-bypasses if it was off. Mix is
   *  floored at this device's own 0.5 default by the base class (see BaseFxDevice.throwMix) if
   *  it's been dialled lower — not forced to full-wet, just guaranteed at least its own resting
   *  presence. */
  /**
   * How long this build should run so that it ENDS on a bar line.
   *
   * The nominal length is BARS bars. With SNAP on, the end is quantised to the nearest bar
   * boundary on the deck's grid, which moves the end by at most half a bar and therefore the
   * duration by at most half a bar either way. That is the whole feature: a riser exists to
   * arrive somewhere, and "wherever my finger landed plus eight bars" is not a musical place.
   * No grid (stopped deck, unanalysed track) → the nominal length, exactly as before.
   */
  private buildDuration(t: number): number {
    const barSec = (60 / this._bpm) * 4;
    const nominal = Math.max(0.25, this._bars * barSec);
    return this._snap ? noiseBuildEnd(t, nominal, this.grid, barSec * 0.5) : nominal;
  }

  /** The sampled build curve for one AudioParam. `log` interpolates in the musical domain. */
  private envCurve(from: number, to: number, log: boolean): Float32Array<ArrayBuffer> {
    const c = new Float32Array(ENV_POINTS);
    for (let i = 0; i < ENV_POINTS; i++) {
      const e = noiseEase(i / (ENV_POINTS - 1), this._curve);
      c[i] = log ? from * Math.pow(to / from, e) : from + (to - from) * e;
    }
    return c as Float32Array<ArrayBuffer>;
  }

  protected applyThrowBoost(on: boolean) {
    const t = this.ctx.currentTime;
    const g = this.riseGain.gain;
    const f = this.sweep.frequency;
    holdAndCancel(g, t);
    holdAndCancel(f, t);
    if (on) {
      if (this._rise) {
        const dur = this.buildDuration(t);
        this._riseStart = t;
        this._riseEnd = t + dur;
        // DIR decides which way the sweep travels; the level always swells IN, because a build
        // that starts at full level has nothing left to give whichever way its filter is going.
        const lo = this._dir === 0 ? SWEEP_LO : SWEEP_HI;
        const hi = this._dir === 0 ? SWEEP_HI : SWEEP_LO;
        f.setValueCurveAtTime(this.envCurve(lo, hi, true), t, dur);
        g.setValueCurveAtTime(this.envCurve(0.0001, 1, false), t, dur);
        if (this._type === 2) {
          const to = this.tonalOsc.frequency;
          holdAndCancel(to, t);
          // TONAL follows the TRACK's key when the deck knows one: the riser's pitched layer
          // starts on the tonic and climbs in octaves, so it belongs to the record instead of
          // sweeping through it. Unknown key → the old fixed span.
          const root = this._keyHz > 0 ? this._keyHz : 80;
          const top = this._keyHz > 0 ? root * 16 : 3000; // four octaves
          to.setValueCurveAtTime(this.envCurve(this._dir === 0 ? root : top, this._dir === 0 ? top : root, true), t, dur);
        }
        this.applyDuck(t, dur);
      } else {
        this._riseEnd = 0;
        this.applySweep();
        g.setTargetAtTime(1, t, 0.015); // quick gate on
        this.applyDuck(t, 0.05);
      }
    } else {
      this._riseEnd = 0;
      g.setTargetAtTime(0, t, 0.03); // the drop — cut to silence
      this.duckGain.gain.cancelScheduledValues(t);
      this.duckGain.gain.setTargetAtTime(1, t, 0.06); // the music comes straight back up
      this.fireImpact(t);
    }
  }

  /** Pull the DRY down as the build climbs — the fader move, automated. */
  private applyDuck(t: number, dur: number) {
    const d = this.duckGain.gain;
    holdAndCancel(d, t);
    if (this._duck <= 0) {
      d.setTargetAtTime(1, t, 0.05);
      return;
    }
    const floor = 1 - clamp01(this._duck) * 0.8; // full DUCK still leaves the track audible
    d.setValueCurveAtTime(this.envCurve(1, floor, false), t, Math.max(0.05, dur));
  }

  /**
   * The hit on release. A riser that ends in silence is half a gesture — the drop wants an
   * impact, and every DJ drops one in by hand. Noise burst (the crash) + a falling sine (the
   * sub), both one-shots that free themselves; nothing is left running between throws.
   *
   * Levels are set so that IMPACT at its maximum, over a full-wet riser, still lands under 0 dBFS
   * (measured: 1.31 peak at 0.5/0.8, 0.87 at these). A control that clips at its own top of range
   * is a control with a smaller usable range than its label claims.
   */
  private fireImpact(t: number) {
    if (this._impact <= 0) return;
    const ctx = this.ctx;
    const amp = clamp01(this._impact);
    const crash = ctx.createBufferSource();
    crash.buffer = this.white;
    crash.loop = false;
    const cg = ctx.createGain();
    const chp = ctx.createBiquadFilter();
    chp.type = "highpass";
    chp.frequency.value = 900;
    cg.gain.setValueAtTime(0.0001, t);
    cg.gain.exponentialRampToValueAtTime(0.32 * amp, t + 0.004); // near-instant strike
    cg.gain.exponentialRampToValueAtTime(0.0001, t + 1.1); // …then a long wash
    crash.connect(chp).connect(cg).connect(this.impactBus);
    const sub = ctx.createOscillator();
    sub.type = "sine";
    const sg = ctx.createGain();
    sub.frequency.setValueAtTime(80, t);
    sub.frequency.exponentialRampToValueAtTime(32, t + 0.18);
    sg.gain.setValueAtTime(0.0001, t);
    sg.gain.exponentialRampToValueAtTime(0.5 * amp, t + 0.008);
    sg.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
    sub.connect(sg).connect(this.impactBus);
    crash.start(t);
    crash.stop(t + 1.2);
    sub.start(t);
    sub.stop(t + 0.6);
    const free = () => {
      crash.disconnect();
      chp.disconnect();
      cg.disconnect();
      sub.disconnect();
      sg.disconnect();
    };
    crash.onended = free;
  }

  // ---- live reads for the WYSIWYG -----------------------------------------
  get typeIndex() {
    return this._type;
  }
  get rising() {
    return this._rise;
  }
  // ★ Commanded, not live — `.value` chases setTargetAtTime and freezes solid whenever the
  // AudioContext isn't actively rendering (e.g. before the first user gesture resumes it), which
  // reads as "the drag did nothing" even though the param moved. See htl-direct-manipulation
  // rule 1.
  get sweepHz() {
    return sweepHzOf(this._sweep);
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
      { id: "dir", def: 0, get: () => this._dir, set: (v) => this.setDir(v) },
      { id: "curve", def: 0.5, get: () => this._curve, set: (v) => this.setCurve(v) },
      // SNAP defaults ON: landing on the downbeat is what a riser is FOR, and the un-snapped
      // build is the deliberate choice (a free sweep over a section with no grid to hit).
      { id: "snap", def: 1, get: () => (this._snap ? 1 : 0), set: (v) => this.setSnap(v >= 0.5) },
      { id: "width", def: 0, get: () => this._width, set: (v) => this.setWidth(v) },
      { id: "duck", def: 0, get: () => this._duck, set: (v) => this.setDuck(v) },
      { id: "impact", def: 0, get: () => this._impact, set: (v) => this.setImpact(v) },
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
