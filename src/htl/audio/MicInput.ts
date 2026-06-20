// Live microphone input — the DJ mic: TALKOVER (mixed into the master, with HPF + auto-duck so
// the music dips while you talk) and a SAMPLING tap (the recorder can grab the mic to make a
// pad clip). getUserMedia needs a user gesture + a secure context (HTTPS / localhost); the
// stream is acquired lazily on enable(). All native Web Audio — the duck is a true audio-rate
// sidechain (mic envelope → −depth → the music bus gain), no polling.
//
//   getUserMedia → source → HPF → level ─┬─→ master            (talkover into the mix)
//                                         ├─→ tap               (recorder / sampler source)
//                                         └─→ |x| → LP → −duck ─→ musicDuck.gain   (sidechain)
import { makeRectifyCurve, makeClampCurve } from "./duckingHelper";

export class MicInput {
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private readonly hpf: BiquadFilterNode; // rumble / plosive cut
  private readonly level: GainNode; // mic → master (muted until ON)
  private readonly tapNode: GainNode; // post-level tap for the recorder / sampler
  private readonly rect: WaveShaperNode; // |x| envelope of the (post-level) mic
  private readonly clamp: WaveShaperNode; // saturate the envelope to [0,1] (no over-duck/invert)
  private readonly duckLP: BiquadFilterNode; // smooth the envelope (~12 Hz)
  private readonly duckDepth: GainNode; // −depth → pulls the music bus gain down
  private readonly monitor: GainNode; // pre-level PFL send → cue bus (hear yourself in headphones)
  private readonly meterAn: AnalyserNode; // input level (pre-level, post-HPF) for the UI meter
  private readonly meterBuf: Float32Array<ArrayBuffer>;

  private _level = 0.85;
  private _duck = 0.6; // 0..1: how far the music dips when the mic is hot
  private _on = false; // talkover engaged (level → master)
  private _monitor = false; // PFL — route the mic to the cue/headphone bus
  private _hasStream = false;
  private _deviceId = ""; // chosen input device ("" = system default)

  constructor(
    private readonly ctx: AudioContext,
    private readonly master: AudioNode, // talkover destination
    private readonly musicDuck: AudioParam, // the music-bus gain we modulate (rests at 1)
  ) {
    this.hpf = ctx.createBiquadFilter();
    this.hpf.type = "highpass";
    this.hpf.frequency.value = 90;
    this.level = ctx.createGain();
    this.level.gain.value = 0; // silent until ON (and a stream exists)
    this.tapNode = ctx.createGain();
    this.rect = ctx.createWaveShaper();
    this.rect.curve = makeRectifyCurve();
    this.clamp = ctx.createWaveShaper();
    this.clamp.curve = makeClampCurve();
    this.duckLP = ctx.createBiquadFilter();
    this.duckLP.type = "lowpass";
    this.duckLP.frequency.value = 12;
    this.duckDepth = ctx.createGain();
    this.duckDepth.gain.value = 0; // set to −duck while ON
    this.monitor = ctx.createGain();
    this.monitor.gain.value = 0; // PFL send, off until monitoring
    this.meterAn = ctx.createAnalyser();
    this.meterAn.fftSize = 256;
    this.meterBuf = new Float32Array(this.meterAn.fftSize);

    // static graph (the source attaches on enable):
    this.hpf.connect(this.level);
    this.hpf.connect(this.meterAn); // meter the INPUT (pre-level) so it reads even before talkover
    this.hpf.connect(this.monitor); // PFL → cue bus (engine wires monitor → cueMaster)
    this.level.connect(this.master); // talkover
    this.level.connect(this.tapNode); // recorder / sampler tap
    // sidechain duck: post-level envelope → −depth → music gain. Rests at the param's 1.0; a hot
    // mic adds a negative offset, dipping the music. clamp keeps the offset in [0,1]·(−depth).
    this.level.connect(this.rect).connect(this.clamp).connect(this.duckLP).connect(this.duckDepth);
    this.duckDepth.connect(this.musicDuck);
  }

  /** PFL monitor send — the engine connects this to the cue/headphone bus. */
  get monitorOut(): AudioNode {
    return this.monitor;
  }
  /** Live input level (RMS 0..1, pre-level) for the UI meter. 0 until a stream is acquired. */
  get inputLevel(): number {
    if (!this._hasStream) return 0;
    this.meterAn.getFloatTimeDomainData(this.meterBuf);
    let s = 0;
    for (let i = 0; i < this.meterBuf.length; i++) s += this.meterBuf[i] * this.meterBuf[i];
    return Math.min(1, Math.sqrt(s / this.meterBuf.length) * 2.2);
  }
  get monitoring() {
    return this._monitor;
  }
  setMonitor(on: boolean) {
    this._monitor = on;
    this.monitor.gain.setTargetAtTime(this._hasStream && on ? 1 : 0, this.ctx.currentTime, 0.02);
  }

  /** The post-level mic signal — what the recorder/sampler captures. */
  get tap(): AudioNode {
    return this.tapNode;
  }
  get hasStream() {
    return this._hasStream;
  }
  get on() {
    return this._on;
  }
  get levelValue() {
    return this._level;
  }
  get duckValue() {
    return this._duck;
  }

  /** The chosen input device id ("" = system default). */
  get deviceId() {
    return this._deviceId;
  }

  /** Acquire the mic stream (user gesture + secure context). Idempotent; returns success.
   *  `deviceId` selects a specific input ("" = system default). */
  async enable(deviceId = this._deviceId): Promise<boolean> {
    if (this._hasStream && deviceId === this._deviceId) return true;
    const wasOn = this._on;
    if (this._hasStream) this.disable(); // switching device → re-acquire
    this._deviceId = deviceId;
    try {
      // No DSP cleanup on the input — echo-cancel / noise-suppress / AGC mangle music + a sung mic.
      const audio: MediaTrackConstraints = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
      if (deviceId) audio.deviceId = { exact: deviceId };
      this.stream = await navigator.mediaDevices.getUserMedia({ audio });
    } catch {
      return false; // permission denied / no device / insecure context
    }
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.source.connect(this.hpf);
    this._hasStream = true;
    this._on = wasOn; // keep talkover state across a device switch
    this.applyLevel();
    this.applyDuck();
    this.setMonitor(this._monitor);
    return true;
  }

  /** Switch the input device, re-acquiring if a stream is already live. */
  async setDevice(deviceId: string): Promise<boolean> {
    if (deviceId === this._deviceId) return true;
    if (!this._hasStream) {
      this._deviceId = deviceId; // not live yet — just remember for the next enable()
      return true;
    }
    return this.enable(deviceId);
  }

  /** Release the mic (stops the OS capture indicator). */
  disable() {
    this._on = false;
    this.applyLevel();
    try {
      this.source?.disconnect();
    } catch {
      /* ignore */
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.source = null;
    this._hasStream = false;
  }

  /** Talkover on/off — ramps the mic into/out of the master (and arms/disarms the duck). */
  setOn(on: boolean) {
    this._on = on;
    this.applyLevel();
    this.applyDuck();
  }
  setLevel(v: number) {
    this._level = Math.max(0, Math.min(1, v));
    this.applyLevel();
  }
  setDuck(v: number) {
    this._duck = Math.max(0, Math.min(1, v));
    this.applyDuck();
  }

  private applyLevel() {
    const g = this._hasStream && this._on ? this._level : 0;
    this.level.gain.setTargetAtTime(g, this.ctx.currentTime, 0.02);
  }
  private applyDuck() {
    const d = this._hasStream && this._on ? -this._duck : 0;
    this.duckDepth.gain.setTargetAtTime(d, this.ctx.currentTime, 0.03);
  }

  dispose() {
    this.disable();
    try {
      this.duckDepth.disconnect();
    } catch {
      /* ignore */
    }
  }
}
