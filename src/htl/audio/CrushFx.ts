// Bitcrusher (CRUSH) — Pixelator (modes) × Decimort (DAC filter / jitter) flavor. The wet
// path runs the input through the crush WORKLET (bit + sample-rate reduction; native nodes
// can't sample-and-hold) into a native resonant lowpass (the DAC reconstruction / image
// filter — controls how much aliasing/grit survives), as a BaseFxDevice INSERT (dry·(1−mix)
// crossfade, free when bypassed). The worklet module is addModule()'d once by AudioEngine;
// the node is created on demand here, with a passthrough fallback if the module is missing.
import { BaseFxDevice, type FxKind } from "./Fx";
import { clamp01, logMap } from "./fxDsp";

export const CRUSH_MODES = ["S&H", "ZERO", "VINTAGE", "JITTER"] as const;
export type CrushMode = (typeof CRUSH_MODES)[number];

// 0..1 knob → bit depth: 0 = 16 (clean) … 1 = ~1.5 bits (smashed).
const extToBits = (e: number) => 16 - clamp01(e) * 14.5;
// 0..1 → downsample divisor 1..64 (exponential — most of the action is up top).
const extToRate = (e: number) => 1 + clamp01(e) * clamp01(e) * 63;
// 0..1 → filter cutoff, log 200 Hz‥18 kHz (1 = effectively open).
const extToHz = logMap(200, 18000);

// RES → the post filter's resonance. Web Audio reads a lowpass/highpass Q in DECIBELS, so res=0
// used to mean 0.7 dB — already resonant. −3.01 dB is flat, and the knob climbs from there.
const resQdB = (res: number) => -3.01 + res * 11;

export class CrushFx extends BaseFxDevice {
  readonly kind: FxKind = "crush";
  private node: AudioWorkletNode | null = null;
  private readonly post: BiquadFilterNode;
  private _bits = 0.4;
  private _rate = 0.3;
  private _jitter = 0;
  private _mode = 0;
  private _cut = 1;
  private _res = 0.2;

  constructor(ctx: AudioContext) {
    super(ctx, 1.0); // insert (full wet by default)
    this.post = ctx.createBiquadFilter();
    this.post.type = "lowpass";
    this.post.frequency.value = extToHz(this._cut);
    this.post.Q.value = resQdB(this._res);
    try {
      this.node = new AudioWorkletNode(ctx, "crush", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: "explicit" });
      this.input.connect(this.node).connect(this.post).connect(this.wet);
      this.pushAll();
    } catch {
      this.input.connect(this.post).connect(this.wet); // module not ready → filter-only passthrough
    }
    this.applyDry();
    this.registerParams();
  }

  private pushAll() {
    this.node?.port.postMessage({ bits: extToBits(this._bits), rate: extToRate(this._rate), jitter: this._jitter, mode: this._mode });
  }

  // Insert crossfade: dry = (1 − mix) when active, full when bypassed (BaseFxDevice keeps dry
  // at unity for send effects; a crusher must REPLACE the dry, not stack on it).
  private applyDry() {
    this.dry.gain.setTargetAtTime(this.isBypassed ? 1 : 1 - this.mixAmount, this.ctx.currentTime, 0.01);
  }
  protected setMix(v: number) {
    super.setMix(v);
    this.applyDry();
  }
  setBypass(on: boolean) {
    super.setBypass(on);
    this.applyDry();
  }

  private setBits(e: number) {
    this._bits = clamp01(e);
    if (!this.throwing) this.node?.port.postMessage({ bits: extToBits(this._bits) });
  }
  private setRate(e: number) {
    this._rate = clamp01(e);
    if (!this.throwing) this.node?.port.postMessage({ rate: extToRate(this._rate) });
  }
  private setJitter(e: number) {
    this._jitter = clamp01(e);
    this.node?.port.postMessage({ jitter: this._jitter });
  }
  private setMode(v: number) {
    this._mode = Math.max(0, Math.min(CRUSH_MODES.length - 1, Math.round(v)));
    this.node?.port.postMessage({ mode: this._mode });
  }
  private setCut(e: number) {
    this._cut = clamp01(e);
    this.post.frequency.setTargetAtTime(extToHz(this._cut), this.ctx.currentTime, 0.01);
  }
  private setRes(e: number) {
    this._res = clamp01(e);
    this.post.Q.setTargetAtTime(resQdB(this._res), this.ctx.currentTime, 0.01);
  }

  /** Pad-throw TRIGGER: engage (un-bypass if dormant) + smash to a heavy crush while held;
   *  release restores the user's setting and re-bypasses if it was off. Mix is guaranteed
   *  audible by the base class (see BaseFxDevice.throwMix). */
  protected applyThrowBoost(on: boolean) {
    this.node?.port.postMessage({ bits: extToBits(on ? 0.82 : this._bits), rate: extToRate(on ? 0.7 : this._rate) });
  }

  // Live reads for the WYSIWYG scope.
  get bitsValue() {
    return extToBits(this._bits);
  }
  get rateDiv() {
    return extToRate(this._rate);
  }
  get modeIndex() {
    return this._mode;
  }

  private registerParams() {
    this.params.push(
      { id: "mode", def: 0, get: () => this._mode, set: (v) => this.setMode(v) },
      { id: "bits", def: 0.4, get: () => this._bits, set: (v) => this.setBits(v) },
      { id: "rate", def: 0.3, get: () => this._rate, set: (v) => this.setRate(v) },
      { id: "jitter", def: 0, get: () => this._jitter, set: (v) => this.setJitter(v) },
      { id: "cut", def: 1, get: () => this._cut, set: (v) => this.setCut(v) },
      { id: "res", def: 0.2, get: () => this._res, set: (v) => this.setRes(v) },
    );
  }

  dispose() {
    try {
      this.node?.disconnect();
    } catch {
      /* ignore */
    }
    super.dispose();
  }
}
