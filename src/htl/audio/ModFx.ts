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

export const MOD_MODES = ["CHORUS", "FLANGER", "PHASER"] as const;
export const MOD_WAVES = ["SINE", "TRI", "SQUARE"] as const;
export const MOD_SOURCES = ["LFO", "ENV", "BOTH"] as const;

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const extToRate = (e: number) => 0.05 * Math.pow(200, clamp01(e)); // 0.05‥10 Hz log
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
  private _rate = 0.3;
  private _depth = 0.5;
  private _fb = 0.3;
  private _tone = 0.5;
  private _stages = 6;
  private _wave = 0;
  private _src = 0;
  private _thru = false;
  private _throw = false;

  constructor(ctx: AudioContext) {
    super(ctx, 0.5); // send-style, half wet (equal dry/wet = deepest notches)
    this.lfo = ctx.createOscillator();
    this.lfo.type = "sine";
    this.lfo.frequency.value = extToRate(this._rate);
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
      scale.gain.value = this._depth * 1300 * (this._throw ? 1.6 : 1);
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
        node.port.postMessage({ base: baseSec * sr, depth: this._depth * magSec * sr * (this._throw ? 1.6 : 1), fb: flanger ? this._fb * 0.85 : 0 });
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
        scale.gain.value = this._depth * magSec * (this._throw ? 1.6 : 1);
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
    this.delayNode.port.postMessage({ depth: this._depth * magSec * this.ctx.sampleRate * (this._throw ? 1.6 : 1), fb: flanger ? this._fb * 0.85 : 0 });
  }

  private applyDepth() {
    const boost = this._throw ? 1.6 : 1;
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
  private setRate(e: number) {
    this._rate = clamp01(e);
    this.lfo.frequency.setTargetAtTime(extToRate(this._rate), this.ctx.currentTime, 0.02);
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

  /** Pad-throw: deepen the swirl (depth + feedback) while held. */
  setThrow(on: boolean) {
    this._throw = on;
    this.applyDepth();
    if (this.fbGain) this.fbGain.gain.setTargetAtTime(Math.min(0.95, this._fb * 0.8 + (on ? 0.2 : 0)), this.ctx.currentTime, 0.02);
    this.postDelay();
  }
  get throwing() {
    return this._throw;
  }

  // Live reads for the viz.
  get modeIndex() {
    return this._mode;
  }
  get rateHz() {
    return extToRate(this._rate);
  }
  get stages() {
    return this._stages;
  }

  private registerParams() {
    this.params.push(
      { id: "mode", def: 0, get: () => this._mode, set: (v) => this.setMode(v) },
      { id: "rate", def: 0.3, get: () => this._rate, set: (v) => this.setRate(v) },
      { id: "depth", def: 0.5, get: () => this._depth, set: (v) => this.setDepth(v) },
      { id: "feedback", def: 0.3, get: () => this._fb, set: (v) => this.setFeedback(v) },
      { id: "tone", def: 0.5, get: () => this._tone, set: (v) => this.setTone(v) },
      { id: "stages", def: 6, get: () => this._stages, set: (v) => this.setStages(v) },
      { id: "wave", def: 0, get: () => this._wave, set: (v) => this.setWave(v) },
      { id: "src", def: 0, get: () => this._src, set: (v) => this.setSrc(v) },
      { id: "thru", def: 0, get: () => (this._thru ? 1 : 0), set: (v) => this.setThru(v >= 0.5) },
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
