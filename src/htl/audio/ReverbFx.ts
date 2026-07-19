// Reverb — a Jot Feedback Delay Network in an AudioWorklet (see reverbWorklet.ts) wrapped in
// native peripherals. The worklet is the TANK (input diffusion + N-line FDN with a lossless
// Householder matrix, per-line Jot decay gains, one-pole damping, slow modulation, decorrelated
// stereo) — the part that needs single-sample feedback + a true matrix + interpolated modulated
// delays, which native nodes can't do. Everything around it stays native:
//
//   input → drive → preDelay → inHP → inLP → [FDN worklet, stereo] → M/S width → postEQ → duck → wet
//                                                                                                  (dry ─→ output)
//
// Extends BaseFxDevice, so it inherits the rack's activation gate — when bypassed/at mix 0 the
// whole wet path (worklet included) is pruned, costing nothing.
//
// Worklet params (size/decay/brightness/character/modRate/freeze/style) ride PORT MESSAGES, not
// AudioParams (iOS Safari kills worklets whose parameterDescriptors fail). Native params
// (predelay/width/lowCut/highCut/drive/duck/postLow/postHigh/mix) drive the surrounding nodes.

import { BaseFxDevice, type FxKind } from "./Fx";
import { clamp, clamp01 } from "../../util/math";
import { makeRectifyCurve, makeClampCurve } from "./duckingHelper";

// Mode labels (the worklet owns the per-style voicing table; this is just the UI labels +
// the index that rides the `style` param).
export const REVERB_STYLES = ["HALL", "ROOM", "PLATE", "AMBIENT"] as const;

// Web Audio reads Q in DECIBELS for lowpass/highpass, so "0.7" is 0.7 dB of RESONANCE, not a
// Butterworth Q — it put a +1.7 dB bump right at lowCut/highCut on the wet path. −3.01 dB is flat.
const FLAT_Q_DB = -3.01;

export class ReverbFx extends BaseFxDevice {
  readonly kind: FxKind = "reverb";

  private readonly drive: WaveShaperNode;
  private readonly preDelay: DelayNode;
  private readonly inHP: BiquadFilterNode;
  private readonly inLP: BiquadFilterNode;
  private node: AudioWorkletNode | null = null;
  // M/S width matrix (split → 4 gains → merge).
  private readonly wSplit: ChannelSplitterNode;
  private readonly wLL: GainNode;
  private readonly wRL: GainNode;
  private readonly wLR: GainNode;
  private readonly wRR: GainNode;
  private readonly wMerge: ChannelMergerNode;
  private readonly postLow: BiquadFilterNode;
  private readonly postHigh: BiquadFilterNode;
  // Ducking sidechain (lazily wired — same pattern as the delay).
  private readonly rect: WaveShaperNode;
  private readonly duckScale: GainNode;
  private readonly seriesDuck: GainNode;
  // ★ AudioParam.value cannot see modulation delivered via .connect() — seriesDuck.gain.value would
  // read frozen at its intrinsic 1 forever, exactly like DelayFx's identical bug (see
  // htl-webaudio-footguns memory). Tap duckScale's own output instead — same fix, same reason.
  private readonly duckMeter: AnalyserNode;
  private readonly duckMeterBuf: Float32Array<ArrayBuffer>;

  private _width = 1;
  // The commanded values of the params that GLIDE (see the params block). Their AudioParams chase
  // these; the getters must not.
  private readonly _cmd = { predelay: 0.012, lowCut: 20, highCut: 18000, postLow: 0, postHigh: 0 };
  private _drive = 0;
  private _duckWired = false;
  private _duckGen = 0;
  private _duckAmt = 0;
  // Worklet param values (for getParam; the worklet is the source of truth for the sound).
  private readonly wp: Record<string, number> = { size: 0.6, decay: 0.5, brightness: 0.6, character: 0, modRate: 0.35, freeze: 0, style: 0 };

  constructor(ctx: AudioContext) {
    super(ctx, 0.3);

    this.drive = ctx.createWaveShaper();
    this.drive.oversample = "2x";
    this.preDelay = ctx.createDelay(0.25);
    this.preDelay.delayTime.value = 0.012;
    this.inHP = ctx.createBiquadFilter();
    this.inHP.type = "highpass";
    this.inHP.frequency.value = 20;
    this.inHP.Q.value = FLAT_Q_DB;
    this.inLP = ctx.createBiquadFilter();
    this.inLP.type = "lowpass";
    this.inLP.frequency.value = 18000;
    this.inLP.Q.value = FLAT_Q_DB;

    this.input.connect(this.drive);
    this.drive.connect(this.preDelay);
    this.preDelay.connect(this.inHP);
    this.inHP.connect(this.inLP);

    // M/S width + post tone shelves + duck, after the tank.
    this.wSplit = ctx.createChannelSplitter(2);
    this.wMerge = ctx.createChannelMerger(2);
    this.wLL = ctx.createGain();
    this.wRL = ctx.createGain();
    this.wLR = ctx.createGain();
    this.wRR = ctx.createGain();
    this.wSplit.connect(this.wLL, 0);
    this.wSplit.connect(this.wLR, 0);
    this.wSplit.connect(this.wRL, 1);
    this.wSplit.connect(this.wRR, 1);
    this.wLL.connect(this.wMerge, 0, 0);
    this.wRL.connect(this.wMerge, 0, 0);
    this.wLR.connect(this.wMerge, 0, 1);
    this.wRR.connect(this.wMerge, 0, 1);

    this.postLow = ctx.createBiquadFilter();
    this.postLow.type = "lowshelf";
    this.postLow.frequency.value = 250;
    this.postHigh = ctx.createBiquadFilter();
    this.postHigh.type = "highshelf";
    this.postHigh.frequency.value = 4000;
    this.rect = ctx.createWaveShaper();
    this.rect.curve = makeRectifyCurve();
    const smooth = ctx.createBiquadFilter();
    smooth.type = "lowpass";
    smooth.frequency.value = 12;
    const duckEnv = ctx.createGain();
    duckEnv.gain.value = 4;
    const clampShaper = ctx.createWaveShaper();
    clampShaper.curve = makeClampCurve();
    this.duckScale = ctx.createGain();
    this.duckScale.gain.value = 0;
    this.seriesDuck = ctx.createGain();
    this.seriesDuck.gain.value = 1;
    this.rect.connect(smooth);
    smooth.connect(duckEnv);
    duckEnv.connect(clampShaper);
    clampShaper.connect(this.duckScale);
    this.wMerge.connect(this.postLow);
    this.postLow.connect(this.postHigh);
    this.postHigh.connect(this.seriesDuck);
    this.seriesDuck.connect(this.wet);
    this.duckMeter = ctx.createAnalyser();
    this.duckMeter.fftSize = 256;
    this.duckMeter.smoothingTimeConstant = 0; // already smoothed upstream (the 12Hz follower)
    this.duckMeterBuf = new Float32Array(this.duckMeter.fftSize);
    this.duckScale.connect(this.duckMeter);

    // The FDN tank worklet. The module is registered at engine init; if it isn't ready (a
    // very early add) we degrade to the filtered signal so nothing crashes.
    try {
      this.node = new AudioWorkletNode(ctx, "reverbfdn", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: "explicit" });
      this.inLP.connect(this.node);
      this.node.connect(this.wSplit);
      for (const k in this.wp) this.node.port.postMessage({ k, v: this.wp[k] });
    } catch (e) {
      console.warn("[htl] reverb FDN worklet unavailable, degrading:", e);
      this.inLP.connect(this.wSplit);
    }

    this.applyWidth();

    // ★ The five gliding params below report their COMMANDED value, not the AudioParam's live one.
    // setTargetAtTime is exponential — it never exactly arrives — so a getter reading `.value` is
    // permanently chasing the target. The DOME is a direct-manipulation surface that renders from
    // these getters, so a lagging read-back makes a dragged handle spring back at the hand that
    // moved it. The audio still glides; only the read-back is honest. (Same fix as DelayFx/Eq3.)
    const cmd = this._cmd;
    this.params.push(
      { id: "size", def: 0.6, get: () => this.wp.size, set: (v) => this.postWp("size", clamp01(v)) },
      { id: "decay", def: 0.5, get: () => this.wp.decay, set: (v) => this.postWp("decay", clamp01(v)) },
      { id: "brightness", def: 0.6, get: () => this.wp.brightness, set: (v) => this.postWp("brightness", clamp01(v)) },
      { id: "predelay", def: 0.012, get: () => cmd.predelay, set: (v) => { cmd.predelay = clamp(v, 0, 0.2); this.preDelay.delayTime.setTargetAtTime(cmd.predelay, ctx.currentTime, 0.02); } },
      { id: "width", def: 1, get: () => this._width, set: (v) => this.setWidth(clamp(v, 0, 1.5)) },
      { id: "lowCut", def: 20, get: () => cmd.lowCut, set: (v) => { cmd.lowCut = clamp(v, 20, 2000); this.inHP.frequency.setTargetAtTime(cmd.lowCut, ctx.currentTime, 0.02); } },
      { id: "highCut", def: 18000, get: () => cmd.highCut, set: (v) => { cmd.highCut = clamp(v, 1000, 20000); this.inLP.frequency.setTargetAtTime(cmd.highCut, ctx.currentTime, 0.02); } },
      { id: "drive", def: 0, get: () => this._drive, set: (v) => this.setDrive(clamp01(v)) },
      { id: "character", def: 0, get: () => this.wp.character, set: (v) => this.postWp("character", clamp01(v)) },
      { id: "modRate", def: 0.35, get: () => this.wp.modRate, set: (v) => this.postWp("modRate", clamp(v, 0.02, 6)) },
      { id: "postLow", def: 0, get: () => cmd.postLow, set: (v) => { cmd.postLow = clamp(v, -18, 12); this.postLow.gain.setTargetAtTime(cmd.postLow, ctx.currentTime, 0.02); } },
      { id: "postHigh", def: 0, get: () => cmd.postHigh, set: (v) => { cmd.postHigh = clamp(v, -18, 12); this.postHigh.gain.setTargetAtTime(cmd.postHigh, ctx.currentTime, 0.02); } },
      { id: "duck", def: 0, get: () => this._duckAmt, set: (v) => this.setDuck(clamp01(v)) },
      { id: "freeze", def: 0, get: () => this.wp.freeze, set: (v) => this.postWp("freeze", v ? 1 : 0) },
      { id: "style", def: 0, get: () => this.wp.style, set: (v) => this.postWp("style", clamp(Math.round(v), 0, REVERB_STYLES.length - 1)) },
    );
  }

  private postWp(k: string, v: number) {
    this.wp[k] = v;
    this.node?.port.postMessage({ k, v });
  }

  // --- REVERB OUT: the pad throw ----------------------------------------------------------
  // The wet-throw twin of the delay's. Press drenches the tank (mix → 0.85, the base class's
  // throwMix hook); release puts the user's mix back, so the tail BLOOMS out of the throw and
  // decays instead of being chopped. The base keeps the device alive through that bloom before
  // returning it to dormant. Reverb has no character param of its own worth boosting the way
  // delay boosts feedback, so mix is the WHOLE throw — nothing left to override applyThrowBoost for.
  protected get hasTail() {
    return true; // let the tail bloom — see BaseFxDevice.hasTail
  }
  protected get throwMix() {
    return 0.85;
  }
  // A manual bypass's ring-out (BaseFxDevice.muteWetInput) must stop NEW material reaching the
  // tank, or whatever's still playing keeps pumping fresh energy into the FDN and the "tail"
  // never actually decays — it just keeps sounding like the effect never turned off. `drive` is
  // the tank's true entry point (see the constructor); cutting it here leaves whatever energy is
  // ALREADY circulating in the FDN to decay out on its own, undisturbed.
  protected muteWetInput(muted: boolean) {
    if (muted) {
      try {
        this.input.disconnect(this.drive);
      } catch {
        /* already disconnected */
      }
    } else {
      this.input.connect(this.drive);
    }
  }

  private setWidth(v: number) {
    this._width = v;
    this.applyWidth();
  }
  private applyWidth() {
    const now = this.ctx.currentTime;
    const a = 0.5 * (1 + this._width);
    const b = 0.5 * (1 - this._width);
    this.wLL.gain.setTargetAtTime(a, now, 0.02);
    this.wRR.gain.setTargetAtTime(a, now, 0.02);
    this.wRL.gain.setTargetAtTime(b, now, 0.02);
    this.wLR.gain.setTargetAtTime(b, now, 0.02);
  }

  private setDrive(v: number) {
    this._drive = v;
    this.drive.curve = v > 0 ? makeDriveCurve(v) : null;
  }

  // Lazily-wired ducking sidechain (same pattern as the delay).
  private setDuck(amt: number) {
    this._duckAmt = amt;
    const now = this.ctx.currentTime;
    if (amt > 0 && !this._duckWired) {
      this._duckGen++;
      this.input.connect(this.rect);
      this.duckScale.connect(this.seriesDuck.gain);
      this._duckWired = true;
    }
    this.duckScale.gain.setTargetAtTime(-amt, now, 0.02);
    if (amt <= 0 && this._duckWired) {
      const gen = ++this._duckGen;
      setTimeout(() => {
        if (gen !== this._duckGen || !this._duckWired) return;
        try {
          this.input.disconnect(this.rect);
        } catch {
          /* already gone */
        }
        try {
          this.duckScale.disconnect(this.seriesDuck.gain);
        } catch {
          /* already gone */
        }
        this._duckWired = false;
      }, 120);
    }
  }

  // ★ Reads a SIGNAL, not the param — see duckMeter's own comment and htl-webaudio-footguns.
  // duckScale's OWN output is already envelope × −amount, the exact quantity added to
  // seriesDuck.gain, so its most-negative recent sample IS 1 − duckGain.
  get duckGain(): number {
    this.duckMeter.getFloatTimeDomainData(this.duckMeterBuf);
    let min = 0; // duckScale's output is always ≤ 0
    for (const v of this.duckMeterBuf) if (v < min) min = v;
    return clamp(1 + min, 0, 1);
  }

  override dispose() {
    super.dispose();
    const nodes: (AudioNode | null)[] = [this.drive, this.preDelay, this.inHP, this.inLP, this.node, this.wSplit, this.wLL, this.wRL, this.wLR, this.wRR, this.wMerge, this.postLow, this.postHigh, this.rect, this.duckScale, this.seriesDuck, this.duckMeter];
    for (const n of nodes) {
      try {
        n?.disconnect();
      } catch {
        /* ignore */
      }
    }
    this.node = null;
  }
}

// tanh soft-clip drive, level-matched so unity stays ~unity (Arturia-style input character).
function makeDriveCurve(amount: number): Float32Array<ArrayBuffer> {
  const n = 2048;
  const curve = new Float32Array(n);
  const k = 1 + amount * 6;
  const norm = Math.tanh(k);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(k * x) / norm;
  }
  return curve;
}
