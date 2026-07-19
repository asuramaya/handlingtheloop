// Modulation (MOD) — chorus / flanger / phaser, the MetaFlanger × Arturia model. One shared
// MOD WRAPPER (an LFO + an envelope follower, blended) feeds a SWAPPABLE inner engine picked
// by MODE: chorus & flanger are a modulated DelayNode (long/short + feedback); a phaser is a
// real ALLPASS cascade (non-uniform notches — not a comb fake). Send-style (dry + wet sum is
// what creates the comb/notch cancellation), all native Web Audio (no worklet).
//
//   input ─┬─→ dry ──────────────────────────────────────────────→ output
//          ├─→ engineIn → [delay | allpass cascade] → toneFilter → wet → output
//          └─→ rect→lp→envGain ─┐                         ┌ lfo→lfoGain
//                                modBus → modScale(s) → (delayTime | allpass freqs)
import { BaseFxDevice, type FxKind } from "./Fx";
import { logMap, SyncRate, MOD_DIVS } from "./fxDsp";

export const MOD_MODES = ["CHORUS", "FLANGER", "PHASER"] as const;
export const MOD_WAVES = ["SINE", "TRI", "SQUARE"] as const;
export const MOD_SOURCES = ["LFO", "ENV", "BOTH"] as const;

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const modFreeHz = logMap(0.05, 10); // free-mode LFO RATE: 0.05‥10 Hz
const oscType = (w: number): OscillatorType => (w === 1 ? "triangle" : w === 2 ? "square" : "sine");

function absCurve() {
  const n = 1024;
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) c[i] = Math.abs((i / (n - 1)) * 2 - 1); // full-wave rectifier
  return c;
}

export class ModFx extends BaseFxDevice {
  readonly kind: FxKind = "mod";

  // shared mod sources (built once)
  private readonly lfo: OscillatorNode;
  private readonly lfoGain: GainNode;
  private readonly envLp: BiquadFilterNode;
  private readonly envGain: GainNode;
  private readonly modBus: GainNode;
  private readonly engineIn: GainNode; // wet feed (also the feedback re-entry point)
  private readonly tone: BiquadFilterNode; // post HP/LP on the wet

  // engine nodes + per-target mod scales — torn down/rebuilt on mode/stages change.
  private nodes: AudioNode[] = [];
  private scales: { g: GainNode; mag: number }[] = []; // PHASER: native freq-sweep scales
  private fbGain: GainNode | null = null; // PHASER: native feedback gain
  private delayNode: AudioWorkletNode | null = null; // CHORUS/FLANGER: the cubic fractional delay

  private _mode = 0;
  private readonly rate = new SyncRate(MOD_DIVS, modFreeHz, 0.01, 40, 0.3);
  private _depth = 0.5;
  private _fb = 0.3;
  private _tone = 0.5;
  private _stages = 6;
  private _wave = 0;
  private _src = 0;
  private _thru = false;

  constructor(ctx: AudioContext) {
    super(ctx, 0.5); // send-style, half wet (equal dry/wet = deepest notches)
    this.lfo = ctx.createOscillator();
    this.lfo.type = "sine";
    this.lfo.frequency.value = this.rate.hz();
    this.lfoGain = ctx.createGain();
    this.lfo.connect(this.lfoGain);
    this.lfo.start();

    const rect = ctx.createWaveShaper();
    rect.curve = absCurve();
    this.envLp = ctx.createBiquadFilter();
    this.envLp.type = "lowpass";
    this.envLp.frequency.value = 14;
    this.envGain = ctx.createGain();
    this.envGain.gain.value = 0;
    this.input.connect(rect).connect(this.envLp).connect(this.envGain);

    this.modBus = ctx.createGain();
    this.lfoGain.connect(this.modBus);
    this.envGain.connect(this.modBus);

    this.engineIn = ctx.createGain();
    this.tone = ctx.createBiquadFilter();
    this.tone.connect(this.wet);

    this.buildEngine();
    this.applySource();
    this.applyTone();
    this.registerParams();
  }

  // (Re)build the inner engine between engineIn → … → tone, and re-route the mod bus to it.
  private buildEngine() {
    for (const n of this.nodes) safeDisconnect(n);
    for (const s of this.scales) safeDisconnect(s.g);
    safeDisconnect(this.engineIn);
    this.nodes = [];
    this.scales = [];
    this.fbGain = null;
    this.delayNode = null;
    this.input.connect(this.engineIn);
    const ctx = this.ctx;

    if (this._mode === 2) {
      // PHASER — an allpass cascade; the LFO/env sweeps every stage's frequency together.
      // Mitigations vs mud: base notches spread EXPONENTIALLY (not piled in the low-mids),
      // lower Q, and a high-pass in the feedback path so regeneration doesn't build low-end.
      let prev: AudioNode = this.engineIn;
      const aps: BiquadFilterNode[] = [];
      const n = Math.max(1, this._stages - 1);
      for (let i = 0; i < this._stages; i++) {
        const ap = ctx.createBiquadFilter();
        ap.type = "allpass";
        ap.frequency.value = 200 * Math.pow(16, i / n); // 200 Hz‥3.2 kHz, log-spread
        ap.Q.value = 0.5;
        prev.connect(ap);
        prev = ap;
        aps.push(ap);
        this.nodes.push(ap);
      }
      prev.connect(this.tone);
      const fbHp = ctx.createBiquadFilter();
      fbHp.type = "highpass";
      fbHp.frequency.value = 180;
      const fb = ctx.createGain();
      fb.gain.value = this._fb * 0.8;
      prev.connect(fbHp).connect(fb);
      fb.connect(this.engineIn);
      this.fbGain = fb;
      this.nodes.push(fbHp, fb);
      const scale = ctx.createGain();
      scale.gain.value = this._depth * 1300 * (this.throwing ? 1.6 : 1);
      this.modBus.connect(scale);
      for (const ap of aps) scale.connect(ap.frequency);
      this.scales.push({ g: scale, mag: 1300 });
    } else {
      // CHORUS / FLANGER — the cubic-interpolated fractional-delay WORKLET (kills the linear-
      // interp HF muffle = the mud). The mod bus drives delay time at audio rate via input 1;
      // feedback + its high-pass live inside the worklet. Falls back to a native DelayNode if
      // the module isn't ready (muddy but functional).
      const flanger = this._mode === 1;
      const sr = ctx.sampleRate;
      const baseSec = flanger ? (this._thru ? 0.0004 : 0.0028) : 0.018;
      const magSec = flanger ? 0.0022 : 0.006;
      try {
        const node = new AudioWorkletNode(ctx, "moddelay", { numberOfInputs: 2, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: "explicit" });
        this.engineIn.connect(node, 0, 0);
        this.modBus.connect(node, 0, 1);
        node.connect(this.tone);
        node.port.postMessage({ base: baseSec * sr, depth: this._depth * magSec * sr * (this.throwing ? 1.6 : 1), fb: flanger ? this._fb * 0.85 : 0 });
        this.delayNode = node;
        this.nodes.push(node);
      } catch {
        const delay = ctx.createDelay(0.05);
        delay.delayTime.value = baseSec;
        this.engineIn.connect(delay).connect(this.tone);
        this.nodes.push(delay);
        if (flanger) {
          const fb = ctx.createGain();
          fb.gain.value = this._fb * 0.85;
          delay.connect(fb).connect(this.engineIn);
          this.fbGain = fb;
          this.nodes.push(fb);
        }
        const scale = ctx.createGain();
        scale.gain.value = this._depth * magSec * (this.throwing ? 1.6 : 1);
        this.modBus.connect(scale);
        scale.connect(delay.delayTime);
        this.scales.push({ g: scale, mag: magSec });
      }
    }
  }

  // Re-post the worklet delay's depth/feedback in samples (chorus/flanger on the worklet path).
  private postDelay() {
    if (!this.delayNode) return;
    const flanger = this._mode === 1;
    const magSec = flanger ? 0.0022 : 0.006;
    this.delayNode.port.postMessage({ depth: this._depth * magSec * this.ctx.sampleRate * (this.throwing ? 1.6 : 1), fb: flanger ? this._fb * 0.85 : 0 });
  }

  private applyDepth() {
    const boost = this.throwing ? 1.6 : 1;
    for (const s of this.scales) s.g.gain.setTargetAtTime(this._depth * s.mag * boost, this.ctx.currentTime, 0.02);
  }
  private applySource() {
    // LFO is bipolar (±1), the rectified envelope is unipolar (one-directional follow).
    this.lfoGain.gain.setTargetAtTime(this._src === 1 ? 0 : 1, this.ctx.currentTime, 0.02);
    this.envGain.gain.setTargetAtTime(this._src === 0 ? 0 : 4, this.ctx.currentTime, 0.02);
  }
  private applyTone() {
    if (this._tone < 0.5) {
      this.tone.type = "lowpass";
      this.tone.frequency.setTargetAtTime(800 * Math.pow(22.5, this._tone / 0.5), this.ctx.currentTime, 0.02); // 800‥18k
    } else {
      this.tone.type = "highpass";
      this.tone.frequency.setTargetAtTime(20 * Math.pow(100, (this._tone - 0.5) / 0.5), this.ctx.currentTime, 0.02); // 20‥2k
    }
  }

  private setMode(v: number) {
    this._mode = Math.max(0, Math.min(MOD_MODES.length - 1, Math.round(v)));
    this.buildEngine();
  }
  // The live LFO frequency (SYNC division of the tempo, else the free 0.05‥10 Hz knob) lives in
  // the shared SyncRate; the device just re-applies it to the oscillator on change.
  private applyRate() {
    this.lfo.frequency.setTargetAtTime(this.rate.hz(), this.ctx.currentTime, 0.02);
  }
  private setRate(e: number) {
    this.rate.setRate(e);
    this.applyRate();
  }
  private setSync(on: boolean) {
    this.rate.setSync(on);
    this.applyRate();
  }
  /** Panel feeds the deck's live BPM so a synced LFO tracks tempo changes. */
  setSyncBpm(bpm: number) {
    if (this.rate.setBpm(bpm)) this.applyRate();
  }
  private setDepth(e: number) {
    this._depth = clamp01(e);
    this.applyDepth();
    this.postDelay();
  }
  private setFeedback(e: number) {
    this._fb = clamp01(e);
    if (this.fbGain) this.fbGain.gain.setTargetAtTime(this._fb * 0.8, this.ctx.currentTime, 0.02);
    this.postDelay();
  }
  private setTone(e: number) {
    this._tone = clamp01(e);
    this.applyTone();
  }
  private setStages(v: number) {
    this._stages = Math.max(2, Math.min(12, Math.round(v)));
    if (this._mode === 2) this.buildEngine();
  }
  private setWave(v: number) {
    this._wave = Math.max(0, Math.min(MOD_WAVES.length - 1, Math.round(v)));
    this.lfo.type = oscType(this._wave);
  }
  private setSrc(v: number) {
    this._src = Math.max(0, Math.min(MOD_SOURCES.length - 1, Math.round(v)));
    this.applySource();
  }
  private setThru(on: boolean) {
    this._thru = on;
    this.buildEngine();
  }

  /** Pad-throw TRIGGER: engage (un-bypass if dormant) + deepen the swirl (depth + feedback)
   *  while held; release restores it and re-bypasses if it was off. Deliberately does NOT
   *  request a mix boost (see BaseFxDevice.throwMix) — the default 0.5 blend IS the comb-filter's
   *  deepest-notch point; forcing full-wet during a throw would erase the dry reference the
   *  notches are relative to, changing the timbre rather than just the loudness. */
  protected applyThrowBoost(on: boolean) {
    this.applyDepth();
    if (this.fbGain) this.fbGain.gain.setTargetAtTime(Math.min(0.95, this._fb * 0.8 + (on ? 0.2 : 0)), this.ctx.currentTime, 0.02);
    this.postDelay();
  }

  // Live reads for the viz.
  get modeIndex() {
    return this._mode;
  }
  get rateHz() {
    return this.rate.hz();
  }
  get synced() {
    return this.rate.sync;
  }
  get divLabel() {
    return this.rate.divLabel;
  }
  get stages() {
    return this._stages;
  }
  /** The live modulation bus (LFO + envelope) — for the viz to tap and read the real sweep. */
  get modSignal(): AudioNode {
    return this.modBus;
  }
  /** The comb-notch / allpass-notch frequencies for a normalized mod value `m` (−1..1). The
   *  viz reads the real `m` off the mod bus and draws THESE sweeping — emphasising the
   *  modulation over the program audio. */
  modTargets(m: number): number[] {
    const boost = this.throwing ? 1.6 : 1;
    const out: number[] = [];
    if (this._mode === 2) {
      const n = Math.max(1, this._stages - 1);
      const sweep = m * this._depth * 1300 * boost;
      for (let i = 0; i < this._stages; i++) {
        const f = 200 * Math.pow(16, i / n) + sweep;
        if (f > 25 && f < 20000) out.push(f);
      }
      return out;
    }
    const flanger = this._mode === 1;
    const baseSec = flanger ? (this._thru ? 0.0004 : 0.0028) : 0.018;
    const magSec = flanger ? 0.0022 : 0.006;
    let delay = baseSec + m * this._depth * magSec * boost;
    if (delay < 0.00005) delay = 0.00005;
    for (let k = 0; k < 16; k++) {
      const f = (k + 0.5) / delay; // flanger/chorus comb nulls
      if (f >= 20000) break;
      if (f > 25) out.push(f);
    }
    return out;
  }

  private registerParams() {
    this.params.push(
      { id: "mode", def: 0, get: () => this._mode, set: (v) => this.setMode(v) },
      { id: "rate", def: 0.3, get: () => this.rate.ext, set: (v) => this.setRate(v) },
      { id: "depth", def: 0.5, get: () => this._depth, set: (v) => this.setDepth(v) },
      { id: "feedback", def: 0.3, get: () => this._fb, set: (v) => this.setFeedback(v) },
      { id: "tone", def: 0.5, get: () => this._tone, set: (v) => this.setTone(v) },
      { id: "stages", def: 6, get: () => this._stages, set: (v) => this.setStages(v) },
      { id: "wave", def: 0, get: () => this._wave, set: (v) => this.setWave(v) },
      { id: "src", def: 0, get: () => this._src, set: (v) => this.setSrc(v) },
      { id: "thru", def: 0, get: () => (this._thru ? 1 : 0), set: (v) => this.setThru(v >= 0.5) },
      { id: "sync", def: 0, get: () => (this.rate.sync ? 1 : 0), set: (v) => this.setSync(v >= 0.5) },
    );
  }

  dispose() {
    try {
      this.lfo.stop();
    } catch {
      /* already stopped */
    }
    super.dispose();
  }
}

function safeDisconnect(n: AudioNode) {
  try {
    n.disconnect();
  } catch {
    /* ignore */
  }
}
