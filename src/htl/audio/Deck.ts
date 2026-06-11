import type { Beatgrid, KeyInfo, Pyramid, PyramidLevel } from "../analysis/analyze";
import { shiftKey } from "../analysis/analyze";

// LOD pyramid from a precomputed level-0 min/max envelope (bands zeroed — stems
// colour per-stem, not by band). Cheap O(count) downsample; the O(n) min/max pass
// is done time-sliced by the caller so nothing blocks.
function buildLodPyramid(min: Float32Array, max: Float32Array, length: number, sr: number, bucket: number): Pyramid {
  const zeros = (k: number) => new Float32Array(k);
  const levels: PyramidLevel[] = [{ bucket, min, max, low: zeros(min.length), mid: zeros(min.length), high: zeros(min.length) }];
  while (levels[levels.length - 1].min.length > 1) {
    const prev = levels[levels.length - 1];
    const pc = prev.min.length;
    const nc = Math.ceil(pc / 2);
    const lvl: PyramidLevel = { bucket: prev.bucket * 2, min: zeros(nc), max: zeros(nc), low: zeros(nc), mid: zeros(nc), high: zeros(nc) };
    for (let i = 0; i < nc; i++) {
      const a = i * 2;
      const b = Math.min(pc - 1, a + 1);
      lvl.min[i] = Math.min(prev.min[a], prev.min[b]);
      lvl.max[i] = Math.max(prev.max[a], prev.max[b]);
    }
    levels.push(lvl);
  }
  return { sampleRate: sr, length, levels };
}
import { STEM_NAMES, type StemName, type Stems } from "../stems";
import { decodeAudio } from "./decode";
import { Eq3 } from "./Eq3";

// A single deck: source -> EQ3 -> trim gain -> output (into the crossfader).
//
// AudioBufferSourceNode is one-shot, so play/seek/tempo rebuild it; position is
// reconstructed from context time so the playhead stays continuous. The deck
// owns tempo (so Sync can drive it and the UI reflects it), 8 hot cues, and a
// beat-based loop implemented with the source node's native loopStart/loopEnd.

export const HOT_CUE_COUNT = 8;

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

// Peak amplitude of an analyser's current time-domain frame, in dBFS.
function peakDb(an: AnalyserNode, buf: Float32Array<ArrayBuffer>): number {
  an.getFloatTimeDomainData(buf);
  let peak = 0;
  for (let i = 0; i < buf.length; i++) {
    const a = Math.abs(buf[i]);
    if (a > peak) peak = a;
  }
  return peak > 1e-5 ? 20 * Math.log10(peak) : -100;
}

export interface Loop {
  active: boolean;
  start: number;
  end: number;
  beats: number;
}

export class Deck {
  readonly output: GainNode; // channel level fader (feeds the crossfader)
  private readonly trimNode: GainNode;
  private readonly eq: Eq3;
  private readonly filter: BiquadFilterNode; // single-knob HP/LP color filter
  // Post-fader stereo meter: split L/R into two analysers (sinks). The UI reads
  // instantaneous peak per channel and applies its own ballistics, so any number
  // of readers a frame is fine (no shared smoothed state to fight over).
  private readonly meterL: AnalyserNode;
  private readonly meterR: AnalyserNode;
  private readonly meterBuf: Float32Array<ArrayBuffer>; // scratch buffer for time-domain reads
  private readonly ctx: AudioContext;
  private _trim = 1;
  private _level = 1;
  private _eqLow = 0;
  private _eqMid = 0;
  private _eqHigh = 0;
  private _filter = 0; // -1 full low-pass … 0 off … +1 full high-pass
  private _fxOn = true; // FX master: when off the color filter is bypassed
  private _loudness: number | null = null; // cached integrated RMS of the track
  skipBeats = 4; // per-deck jog skip / beat-jump resolution (beats; 4 = one bar)

  buffer: AudioBuffer | null = null;
  beatgrid: Beatgrid | null = null;
  private source: AudioBufferSourceNode | null = null; // the primary source (= sources[0])
  private sources: AudioBufferSourceNode[] = []; // 1 for a plain mix, 4 when playing stems
  private srcGain: GainNode | null = null; // shared declick envelope for the source group
  // Optional 4-stem playback: when set, each stem gets its own live-toggleable gain
  // and the sum (all stems on) is the original mix. null = play the plain buffer.
  private stems: Stems | null = null;
  private stemMuted: Record<StemName, boolean> = { vocals: false, drums: false, bass: false, other: false };
  private stemGain: Record<StemName, number> = { vocals: 1, drums: 1, bass: 1, other: 1 }; // per-stem level (knob)
  private curStemGains: Partial<Record<StemName, GainNode>> = {}; // gains of the live source group
  // Per-stem waveform envelopes for the viewport (null until built off the hot
  // path). `stemPyramidJob` supersedes an in-flight lazy build when stems change.
  stemPyramids: Record<StemName, Pyramid> | null = null;
  private stemPyramidJob = 0;

  private _playing = false;
  private startOffset = 0;
  private startedAt = 0;
  private _rate = 1;
  private _tempo = 0; // percent
  private _keylock = true; // keep pitch constant under tempo by default (modern DJ)
  private _pitchSemis = 0; // musical key shift, −12 … +12 semitones
  key: KeyInfo | null = null; // detected musical key (set after setBuffer)
  private pitchNode: AudioWorkletNode | null = null;
  private scratchNode: AudioWorkletNode | null = null; // continuous scrub resampler
  quantizeOn = false; // magnet: snap cues/loops/jumps to the beatgrid

  // --- jog/platter physics (see scrubBegin / jogTick) ---
  private static readonly MAX_COAST = 3; // cap on release speed (× realtime)
  private jogPhase: "off" | "grab" | "coast" = "off";
  private jogPos = 0; // platter position (track sec) — authoritative while jogging
  private jogVel = 0; // sounding velocity (track-sec / real-sec, signed)
  private handPos = 0; // where the finger says the platter is (accumulated)
  private handVel = 0; // smoothed finger velocity, drives pitch + release fling
  private pendingDelta = 0; // finger motion accumulated since the last tick
  private jogLast = 0; // ctx time of the last tick
  private jogRaf = 0; // requestAnimationFrame handle (0 = loop idle)
  private jogReturnToPlay = false; // release should spin back up to play, not rest
  private _jogWeight = 0.4; // 0 = featherweight/snappy … 1 = heavy flywheel
  private _jogDrag = 0.4; // 0 = frictionless glide … 1 = quick brake
  cuePoint = 0;
  hotCues: (number | null)[] = new Array(HOT_CUE_COUNT).fill(null);
  hotLoops: (Loop | null)[] = new Array(HOT_CUE_COUNT).fill(null); // saved loops per pad
  loop: Loop | null = null;
  loopInPoint: number | null = null; // pending manual loop-in (FLX4 style)

  onEnded?: () => void;

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.eq = new Eq3(ctx);
    // eq -> filter -> trim -> level(output) -> crossfader
    this.filter = ctx.createBiquadFilter();
    this.filter.type = "lowpass";
    this.filter.frequency.value = 22050; // transparent at rest
    this.filter.Q.value = 0.9;
    this.trimNode = ctx.createGain();
    this.output = ctx.createGain();
    this.eq.output.connect(this.filter);
    this.filter.connect(this.trimNode);
    this.trimNode.connect(this.output);
    // Post-fader meter tap: a channel splitter feeding two analyser sinks (no
    // onward connection) so the meter reads exactly what feeds the crossfader,
    // per channel, without altering the audio path.
    const split = ctx.createChannelSplitter(2);
    this.meterL = ctx.createAnalyser();
    this.meterR = ctx.createAnalyser();
    this.meterL.fftSize = 1024;
    this.meterR.fftSize = 1024;
    this.meterBuf = new Float32Array(1024);
    this.output.connect(split);
    split.connect(this.meterL, 0);
    split.connect(this.meterR, 1);
  }

  /** Instantaneous post-fader peak per channel in dBFS (−100 = silence … 0 = full
   *  scale). No smoothing — the UI applies its own meter ballistics, so it's safe
   *  to call from several meters a frame. */
  meterStereo(): { l: number; r: number } {
    return { l: peakDb(this.meterL, this.meterBuf), r: peakDb(this.meterR, this.meterBuf) };
  }

  get playing() {
    return this._playing;
  }
  get duration() {
    return this.buffer?.duration ?? 0;
  }
  get tempo() {
    return this._tempo;
  }
  get rate() {
    return this._rate;
  }
  get keylock() {
    return this._keylock;
  }

  /** Insert the key-lock pitch-shifter between the source and EQ. */
  attachPitchNode(node: AudioWorkletNode) {
    node.connect(this.eq.input);
    this.pitchNode = node;
    this.updatePitch();
    // Re-route a currently-playing source (via its declick gain) through the node.
    if (this.srcGain) {
      try {
        this.srcGain.disconnect();
      } catch {
        /* ignore */
      }
      this.srcGain.connect(node);
    }
  }

  setKeylock(on: boolean) {
    this._keylock = on;
    this.updatePitch();
  }

  /** Wire the scratch resampler in parallel with the source, into the EQ (raw
   *  pitch, bypassing key-lock — scrubbing should pitch like vinyl). */
  attachScratchNode(node: AudioWorkletNode) {
    node.connect(this.eq.input);
    this.scratchNode = node;
    if (this.buffer) this.sendScratchBuffer();
  }

  // Hand the whole decoded track to the resampler (its own copies, so the
  // AudioBuffer's backing store isn't detached by the transfer).
  private sendScratchBuffer() {
    if (!this.scratchNode || !this.buffer) return;
    const b = this.buffer;
    const channels: Float32Array[] = [];
    const transfer: ArrayBuffer[] = [];
    for (let c = 0; c < b.numberOfChannels; c++) {
      const copy = b.getChannelData(c).slice();
      channels.push(copy);
      transfer.push(copy.buffer);
    }
    this.scratchNode.port.postMessage({ type: "load", channels, length: b.length }, transfer);
  }
  private scratchStart() {
    this.scratchNode?.port.postMessage({ type: "start", pos: this.jogPos * this.ctx.sampleRate });
  }
  private scratchMove() {
    // Position only — the worklet reconstructs smooth motion from the position
    // stream itself; feeding it our noisy per-frame velocity made it garbled.
    this.scratchNode?.port.postMessage({ type: "move", pos: this.jogPos * this.ctx.sampleRate });
  }
  private scratchStop() {
    this.scratchNode?.port.postMessage({ type: "stop" });
  }

  // ratio = (key-lock cancels the source's tempo pitch) × (musical key shift).
  // key-lock alone = 1/rate; +N semitones multiplies by 2^(N/12).
  private updatePitch() {
    if (!this.pitchNode) return;
    const lock = this._keylock ? 1 / this._rate : 1;
    const shift = Math.pow(2, this._pitchSemis / 12);
    this.pitchNode.parameters.get("ratio")!.value = lock * shift;
  }

  /** Musical key shift in semitones (−12 … +12). Engages key-lock so the shift
   *  is pitch-only (tempo-independent). */
  get pitch() {
    return this._pitchSemis;
  }
  setPitch(semis: number) {
    this._pitchSemis = Math.max(-12, Math.min(12, Math.round(semis)));
    if (this._pitchSemis !== 0) this._keylock = true;
    this.updatePitch();
  }
  /** The track's key after the current pitch shift (null if un-analysed). */
  get effectiveKey(): KeyInfo | null {
    return this.key ? shiftKey(this.key, this._pitchSemis) : null;
  }
  /** BPM after the tempo fader is applied. */
  get effectiveBpm(): number | null {
    return this.beatgrid ? this.beatgrid.bpm * this._rate : null;
  }

  async loadArrayBuffer(data: ArrayBuffer) {
    this.setBuffer(await decodeAudio(this.ctx, data));
  }

  setBuffer(buffer: AudioBuffer, beatgrid: Beatgrid | null = null) {
    this.stopSource();
    this._playing = false;
    this.startOffset = 0;
    this.cuePoint = 0;
    this.hotCues = new Array(HOT_CUE_COUNT).fill(null);
    this.hotLoops = new Array(HOT_CUE_COUNT).fill(null);
    this.loop = null;
    this.loopInPoint = null;
    this.stopJog();
    this.stems = null; // new track: drop stems until re-derived, reset mutes to all-on
    this.stemMuted = { vocals: false, drums: false, bass: false, other: false };
    this.stemGain = { vocals: 1, drums: 1, bass: 1, other: 1 };
    this.curStemGains = {};
    this.stemPyramids = null;
    this.buffer = buffer;
    this.beatgrid = beatgrid;
    this.key = null; // re-set by the caller from the track analysis
    this._pitchSemis = 0;
    this.updatePitch();
    this._loudness = null; // recompute lazily for the new track
    this.sendScratchBuffer();
  }

  // --- stems -----------------------------------------------------------------
  // A track can carry 4 time-aligned stem buffers (vocals/drums/bass/other) that
  // share the deck's clock, loop and tempo. With stems set, playback sums their
  // per-stem gains so any can be muted live; with all on the sum IS the mix.
  get hasStems(): boolean {
    return this.stems != null;
  }
  stemActive(name: StemName): boolean {
    return !this.stemMuted[name];
  }
  /** The knob level for a stem (0..1.5; 1 = unity). */
  stemLevel(name: StemName): number {
    return this.stemGain[name];
  }
  /** Actual gain applied = level, or 0 when muted. */
  private effectiveStemGain(name: StemName): number {
    return this.stemMuted[name] ? 0 : this.stemGain[name];
  }
  private rampStem(name: StemName) {
    const sg = this.curStemGains[name];
    if (!sg) return;
    const t = this.ctx.currentTime;
    const target = this.effectiveStemGain(name);
    try {
      sg.gain.cancelScheduledValues(t);
      sg.gain.setValueAtTime(sg.gain.value, t);
      sg.gain.linearRampToValueAtTime(target, t + 0.02); // declick level/mute moves
    } catch {
      sg.gain.value = target;
    }
  }
  /** Set a stem's level (the mixer knob). Independent of the mute button. */
  setStemGain(name: StemName, level: number) {
    this.stemGain[name] = Math.max(0, Math.min(1.5, level));
    this.rampStem(name);
  }
  /** Attach (or clear with null) the stem buffers. Swaps a live source group over
   *  seamlessly — all-on sums to the same mix, so there's no audible jump. Also
   *  builds the per-stem waveform envelopes so the viewport can render them. */
  setStems(stems: Stems | null) {
    this.stems = stems;
    // Audio swaps in instantly (all-on === the mix, so it's seamless). The
    // per-stem waveform envelopes are SECOND-CLASS: built lazily off the hot path
    // so they never hang the main / UI / audio threads. Viewport shows the mix
    // waveform until they're ready.
    this.stemPyramids = null;
    const job = ++this.stemPyramidJob;
    if (this._playing) {
      const pos = this.position();
      this.stopSource();
      this.spawnSource(pos);
    }
    if (stems) void this.buildStemPyramidsLazy(stems, job);
  }
  // Time-sliced min/max envelope build (yields ~every 1M samples) — never blocks,
  // and a newer setStems supersedes an in-flight build via the job token.
  private async buildStemPyramidsLazy(stems: Stems, job: number): Promise<void> {
    const idle: () => Promise<void> = () =>
      new Promise((r) =>
        typeof requestIdleCallback !== "undefined" ? requestIdleCallback(() => r()) : setTimeout(r, 0),
      );
    const BUCKET = 256;
    const out = {} as Record<StemName, Pyramid>;
    for (const name of STEM_NAMES) {
      const b = stems[name];
      const ch0 = b.getChannelData(0);
      const ch1 = b.numberOfChannels > 1 ? b.getChannelData(1) : null;
      const n = ch0.length;
      const count = Math.max(1, Math.ceil(n / BUCKET));
      const min = new Float32Array(count);
      const max = new Float32Array(count);
      let bMin = 1;
      let bMax = -1;
      let cnt = 0;
      let bi = 0;
      for (let i = 0; i < n; i++) {
        const s = ch1 ? (ch0[i] + ch1[i]) * 0.5 : ch0[i];
        if (s < bMin) bMin = s;
        if (s > bMax) bMax = s;
        if (++cnt >= BUCKET || i === n - 1) {
          min[bi] = bMin;
          max[bi] = bMax;
          bi++;
          bMin = 1;
          bMax = -1;
          cnt = 0;
        }
        if ((i & 0xfffff) === 0xfffff) {
          await idle();
          if (job !== this.stemPyramidJob) return; // superseded by a newer track/stems
        }
      }
      out[name] = buildLodPyramid(min, max, n, b.sampleRate, BUCKET);
      await idle();
      if (job !== this.stemPyramidJob) return;
    }
    if (job === this.stemPyramidJob) this.stemPyramids = out;
  }
  setStemMute(name: StemName, muted: boolean) {
    this.stemMuted[name] = muted;
    this.rampStem(name);
  }
  toggleStem(name: StemName) {
    this.setStemMute(name, !this.stemMuted[name]);
  }
  /** Reset every stem to its default: level back to unity (1) and un-muted. */
  resetStems() {
    for (const name of STEM_NAMES) {
      this.stemGain[name] = 1;
      this.stemMuted[name] = false;
      this.rampStem(name);
    }
  }

  /** Current playhead position in seconds (wraps inside an active loop). */
  position(): number {
    if (!this.buffer) return 0;
    let pos = this._playing
      ? this.startOffset + (this.ctx.currentTime - this.startedAt) * this._rate
      : this.startOffset;
    if (this._playing && this.loop?.active) {
      const len = this.loop.end - this.loop.start;
      if (len > 0 && pos > this.loop.start) pos = this.loop.start + ((pos - this.loop.start) % len);
    }
    return Math.max(0, Math.min(this.buffer.duration, pos));
  }

  play() {
    this.cancelJog(); // a transport action wins over an in-flight platter coast
    if (!this.buffer || this._playing) return;
    this.spawnSource(this.startOffset);
    this._playing = true;
  }
  pause() {
    this.cancelJog();
    if (!this._playing) return;
    this.startOffset = this.position();
    this.stopSource();
    this._playing = false;
  }
  togglePlay() {
    this._playing ? this.pause() : this.play();
  }

  seek(seconds: number) {
    this.cancelJog();
    const target = Math.max(0, Math.min(this.duration, seconds));
    if (this._playing) {
      this.stopSource();
      this.spawnSource(target);
    } else {
      this.startOffset = target;
    }
  }

  // --- scrubbing (jog-wheel / vinyl feel) ---
  //
  // The waveform drag is modelled as a weighted platter. While the finger is down
  // ("grab") a critically-damped spring pulls the platter toward the finger — a
  // heavier platter trails it (drag you can feel + hear). On release ("coast") the
  // platter keeps its spin and either glides to rest under friction (was paused)
  // or eases back up to play speed like a motor catching it (was playing). One
  // audio grain per animation frame voices the slice the platter sweeps, so the
  // pitch tracks the real platter speed and there's no grain pile-up.

  /** Tune the platter feel. Both 0..1. weight = inertia, drag = coast friction. */
  setJogPhysics(weight: number, drag: number) {
    this._jogWeight = Math.max(0, Math.min(1, weight));
    this._jogDrag = Math.max(0, Math.min(1, drag));
  }

  get scrubbing() {
    return this.jogPhase !== "off";
  }
  /** True while the platter is being dragged OR still coasting after release. */
  get jogging() {
    return this.jogPhase !== "off";
  }

  scrubBegin() {
    if (!this.buffer) return;
    // iOS starts the AudioContext suspended (its clock frozen) until a gesture
    // resumes it. The jog physics tick off ctx.currentTime, so without this a
    // scrub before the first Play sees dt≈0 every frame and the platter never
    // moves. Resuming on the grab gesture unlocks it.
    if (this.ctx.state === "suspended") void this.ctx.resume();
    // Gripping the platter stops it dead (like a hand on vinyl) — it then follows
    // the finger from rest, so there's no forward lurch/creep when you take hold.
    this.jogReturnToPlay = this._playing || (this.jogPhase === "coast" && this.jogReturnToPlay);
    this.jogPos = this.position();
    if (this._playing) {
      this.startOffset = this.jogPos;
      this.stopSource();
      this._playing = false;
    }
    this.handPos = this.jogPos;
    this.jogVel = 0;
    this.handVel = 0;
    this.pendingDelta = 0;
    this.jogLast = this.ctx.currentTime;
    this.jogPhase = "grab";
    this.scratchStart();
    this.startJogLoop();
  }

  /** Accumulate finger motion (track seconds); the physics tick consumes it. */
  scrubMove(deltaSec: number) {
    if (this.jogPhase !== "grab") return;
    this.pendingDelta += deltaSec;
  }

  scrubEnd() {
    if (this.jogPhase !== "grab") return;
    // Fold in any motion that landed in the same frame as the release before
    // handing the platter its release spin.
    const dt = Math.max(this.ctx.currentTime - this.jogLast, 1 / 120);
    this.consumeHand(dt);
    this.jogLast = this.ctx.currentTime;
    // Fling at the finger's release speed, capped so a violent flick can't launch
    // the platter across the whole track (that's what made long skips screech).
    const max = Deck.MAX_COAST;
    this.jogVel = Math.max(-max, Math.min(max, this.handVel));
    this.jogPhase = "coast";
    this.startJogLoop();
  }

  // A tap/click on the waveform: an instant seek with no grab, scrub or momentum.
  // (The viewport only grabs the platter once the finger actually moves, so a tap
  // never enters the jog at all — this just jumps from the current playhead.)
  needleDrop(deltaSec: number) {
    if (this.ctx.state === "suspended") void this.ctx.resume();
    this.seek(this.position() + deltaSec);
  }

  private startJogLoop() {
    if (this.jogRaf || typeof requestAnimationFrame === "undefined") return;
    this.jogLast = this.ctx.currentTime;
    const tick = () => {
      this.jogRaf = 0;
      const phase = this.jogPhase;
      if (phase === "off") return;
      const now = this.ctx.currentTime;
      let dt = now - this.jogLast;
      this.jogLast = now;
      if (dt > 0) {
        dt = Math.min(dt, 0.05); // a tab-blur gap must not fling the platter
        if (phase === "grab") this.consumeHand(dt);
        else this.stepCoast(dt); // may settle the platter to "off"
        this.startOffset = this.jogPos;
        if (this.jogPhase !== "off") this.scratchMove(); // voice the platter motion
      }
      if (this.jogPhase !== "off") this.jogRaf = requestAnimationFrame(tick);
    };
    this.jogRaf = requestAnimationFrame(tick);
  }

  // Abort an in-flight jog (drag or coast) WITHOUT moving the playhead — the
  // current platter position is already mirrored into startOffset each tick, so a
  // transport action (play/pause/seek/cue) simply takes over from where it is.
  private cancelJog() {
    if (this.jogPhase === "off") return;
    this.jogPhase = "off";
    if (this.jogRaf) {
      if (typeof cancelAnimationFrame !== "undefined") cancelAnimationFrame(this.jogRaf);
      this.jogRaf = 0;
    }
    this.jogVel = 0;
    this.handVel = 0;
    this.pendingDelta = 0;
    this.scratchStop();
  }

  // Full reset on track load: cancel the jog and zero the platter.
  private stopJog() {
    this.cancelJog();
    this.jogPos = 0;
    this.handPos = 0;
    this.jogReturnToPlay = false;
  }

  // GRAB step: the platter IS the finger while gripped — 1:1, no spring lag, so
  // scratches are sharp and track the hand exactly (the resampler adds only a few
  // ms of de-zipper smoothing). The platter's weight is felt on RELEASE (the coast
  // momentum below), not as drag under the hand.
  private consumeHand(dt: number) {
    const d = this.pendingDelta;
    this.pendingDelta = 0;
    this.handPos += d;
    const inst = d / dt;
    const hk = 1 - Math.exp(-dt / 0.03); // light velocity smoothing for the fling/extrapolation
    this.handVel += (inst - this.handVel) * hk;
    this.jogPos = this.handPos;
    this.jogVel = this.handVel;
    const dur = this.buffer ? this.buffer.duration : 0;
    if (this.jogPos < 0) {
      this.jogPos = this.handPos = 0;
      this.jogVel = 0;
    } else if (this.jogPos > dur) {
      this.jogPos = this.handPos = dur;
      this.jogVel = 0;
    }
  }

  // COAST step: no finger. Either spin back up to play speed, or rub to a stop.
  private stepCoast(dt: number) {
    if (this.jogReturnToPlay) {
      // Releasing a scrub during playback: catch back to 1× quickly and locally,
      // so the audio glides back to speed where you let go instead of the platter
      // throwing the playhead forward through the track. Weight lengthens it a bit.
      const tau = lerp(0.025, 0.12, this._jogWeight);
      this.jogVel += (this._rate - this.jogVel) * (1 - Math.exp(-dt / tau));
      this.jogPos += this.jogVel * dt;
      this.clampJog();
      if (Math.abs(this.jogVel - this._rate) < 0.03) {
        // Hand the platter back to normal playback, continuing seamlessly: fade
        // the resampler out as the buffer source fades in (both declick).
        this.jogPhase = "off";
        this.scratchStop();
        this.startOffset = this.jogPos;
        this.spawnSource(this.jogPos);
        this._playing = true;
      }
    } else {
      // Friction glide: drag sets the brake strength, weight lengthens the coast.
      // Kept short (sub-second) so a flick eases off instead of spinning away.
      const tau = lerp(0.6, 0.1, this._jogDrag) * lerp(0.7, 1.3, this._jogWeight);
      this.jogVel *= Math.exp(-dt / tau);
      this.jogPos += this.jogVel * dt;
      this.clampJog();
      if (Math.abs(this.jogVel) < 0.02) {
        this.jogPhase = "off";
        this.jogVel = 0;
        this.startOffset = this.jogPos; // settle, paused, where it stopped
        this.scratchStop();
      }
    }
  }

  private clampJog() {
    const dur = this.buffer ? this.buffer.duration : 0;
    if (this.jogPos <= 0) {
      this.jogPos = 0;
      if (this.jogVel < 0) this.jogVel = 0;
    } else if (this.jogPos >= dur) {
      this.jogPos = dur;
      if (this.jogVel > 0) this.jogVel = 0;
    }
  }

  setTempo(tempoPercent: number) {
    const rate = 1 + tempoPercent / 100;
    if (this._playing) {
      this.startOffset = this.position();
      this.startedAt = this.ctx.currentTime;
    }
    this._tempo = tempoPercent;
    this._rate = rate;
    // Glide the rate so fader moves bend the pitch smoothly instead of stepping —
    // applied to every source in the group so stems stay sample-locked.
    const t = this.ctx.currentTime;
    for (const src of this.sources) {
      const p = src.playbackRate;
      try {
        p.cancelScheduledValues(t);
        p.setValueAtTime(p.value, t);
        p.linearRampToValueAtTime(rate, t + 0.02);
      } catch {
        p.value = rate;
      }
    }
    this.updatePitch(); // keep key-lock tracking the tempo
  }

  get quantizing() {
    return this.quantizeOn;
  }
  setQuantize(on: boolean) {
    this.quantizeOn = on;
  }
  private snap(t: number): number {
    const g = this.beatgrid;
    if (!g) return t;
    return g.firstBeat + Math.round((t - g.firstBeat) / g.interval) * g.interval;
  }
  private maybeSnap(t: number): number {
    return this.quantizeOn ? this.snap(t) : t;
  }

  /** Jump by N beats from the current (grid-snapped) position. */
  beatJump(beats: number) {
    const interval = this.beatgrid?.interval ?? 60 / 120;
    const base = this.beatgrid ? this.snap(this.position()) : this.position();
    this.seek(base + beats * interval);
  }

  // --- cue ---
  setCue() {
    this.cuePoint = this.maybeSnap(this.position());
  }
  jumpToCue() {
    this.seek(this.cuePoint);
  }

  // --- hot cues: tap empty pad to set, tap set pad to jump ---
  hotCue(i: number) {
    // A saved loop on this pad takes priority: recall + activate it.
    if (this.hotLoops[i]) {
      this.recallLoop(i);
      return;
    }
    const cur = this.hotCues[i];
    if (cur == null) this.hotCues[i] = this.maybeSnap(this.position());
    else this.seek(cur);
  }
  clearHotCue(i: number) {
    this.hotCues[i] = null;
    this.hotLoops[i] = null;
  }
  slotIsSet(i: number): boolean {
    return this.hotCues[i] != null || this.hotLoops[i] != null;
  }

  /** Save the current loop to pad `i` (so it can be recalled later). */
  saveLoop(i: number): boolean {
    if (!this.loop) return false;
    this.hotLoops[i] = { ...this.loop, active: false };
    this.hotCues[i] = null;
    return true;
  }
  /** Recall + activate the loop saved on pad `i`. */
  recallLoop(i: number) {
    const l = this.hotLoops[i];
    if (!l) return;
    this.loop = { ...l, active: true };
    this.applyLoop();
    this.seek(l.start);
  }

  // --- loops ---
  /** Set + enable a loop of `beats` length, snapped to the beatgrid.
   *  Resizing an ACTIVE loop keeps its in-point anchored (rekordbox behaviour),
   *  so 1/2/4/8 changes the length in place instead of jumping the loop to the
   *  playhead. With no active loop, drop a fresh loop at the current position. */
  setBeatLoop(beats: number) {
    if (!this.buffer) return;
    const interval = this.beatgrid?.interval ?? 60 / 120;
    const start = this.loop?.active ? this.loop.start : this.beatgrid ? this.snap(this.position()) : this.position();
    const end = Math.min(this.duration, start + beats * interval);
    this.loop = { active: true, start, end, beats };
    this.applyLoop();
    // Keep the playhead inside the (possibly shrunk) region so a live source
    // doesn't run past the new loopEnd before wrapping.
    if (this._playing) {
      const pos = this.position();
      if (pos < start || pos > end) this.seek(start);
    }
  }

  // FLX4-style manual loop. With no active loop: tap IN to drop the entry point,
  // tap OUT to set the exit and start looping. With a loop already running, IN
  // and OUT nudge that loop's in/out boundaries so it can be fine-tuned.
  loopIn() {
    const t = this.maybeSnap(this.position());
    if (this.loop?.active) {
      this.loop.start = Math.min(t, this.loop.end - 1e-3);
      this.loop.beats = this.loopBeats(this.loop);
      this.applyLoop();
      if (this._playing && this.position() < this.loop.start) this.seek(this.loop.start);
    } else {
      this.loopInPoint = t;
    }
  }
  loopOut() {
    const t = this.maybeSnap(this.position());
    if (this.loop?.active) {
      if (t > this.loop.start) {
        this.loop.end = t;
        this.loop.beats = this.loopBeats(this.loop);
        this.applyLoop();
      }
      return;
    }
    if (this.loopInPoint == null) return;
    const start = this.loopInPoint;
    const end = t;
    this.loopInPoint = null;
    if (end <= start) return;
    this.loop = { active: true, start, end, beats: 0 };
    this.loop.beats = this.loopBeats(this.loop);
    this.applyLoop();
  }

  private loopBeats(loop: Loop): number {
    const interval = this.beatgrid?.interval ?? 60 / 120;
    return Math.max(1, Math.round((loop.end - loop.start) / interval));
  }

  /** Shift the whole loop by `beats` (keeping its length), grid-locked. Positive
   *  = forward. Used to move a loop a bar/beat at a time without resizing it. */
  moveLoop(beats: number) {
    if (!this.loop) return;
    const interval = this.beatgrid?.interval ?? 60 / 120;
    const len = this.loop.end - this.loop.start;
    let start = this.loop.start + beats * interval;
    if (start < 0) start = 0;
    if (start + len > this.duration) start = Math.max(0, this.duration - len);
    this.loop = { ...this.loop, start, end: start + len };
    this.applyLoop();
    if (this._playing && this.loop.active) {
      const pos = this.position();
      if (pos < start || pos > start + len) this.seek(start);
    }
  }
  reloop() {
    if (!this.loop) return;
    this.loop.active = true;
    this.applyLoop();
    this.seek(this.loop.start);
  }

  toggleLoop() {
    if (!this.loop) return;
    if (this.loop.active) this.rebaseClock(); // turning OFF: anchor before unwrapping
    this.loop.active = !this.loop.active;
    this.applyLoop();
  }
  exitLoop() {
    if (!this.loop) return;
    this.rebaseClock();
    this.loop.active = false;
    this.applyLoop();
  }

  // Re-anchor the playback clock to the CURRENT (wrapped) position. While a loop
  // is active, position() folds the ever-growing raw offset back into the loop
  // with a modulo; the moment the loop stops wrapping, that raw offset would snap
  // the playhead far ahead. Rebasing here keeps it continuous with the audio.
  private rebaseClock() {
    if (!this._playing) return;
    this.startOffset = this.position();
    this.startedAt = this.ctx.currentTime;
  }

  private applyLoop() {
    for (const src of this.sources) {
      if (this.loop?.active) {
        src.loopStart = this.loop.start;
        src.loopEnd = this.loop.end;
        src.loop = true;
      } else {
        src.loop = false;
      }
    }
  }

  // --- EQ / trim ---
  get trim() {
    return this._trim;
  }
  setTrim(gain: number) {
    this._trim = gain;
    this.trimNode.gain.value = gain;
  }
  get level() {
    return this._level;
  }
  setLevel(gain: number) {
    this._level = gain;
    this.output.gain.value = gain;
  }
  get eqLow() {
    return this._eqLow;
  }
  get eqMid() {
    return this._eqMid;
  }
  get eqHigh() {
    return this._eqHigh;
  }
  setEqLow(db: number) {
    this._eqLow = db;
    this.eq.setLow(db);
  }
  setEqMid(db: number) {
    this._eqMid = db;
    this.eq.setMid(db);
  }
  setEqHigh(db: number) {
    this._eqHigh = db;
    this.eq.setHigh(db);
  }

  get filterValue() {
    return this._filter;
  }
  // One-knob DJ color filter: left = low-pass (cutoff sweeps down), right =
  // high-pass (cutoff sweeps up), centre = bypassed. Cutoffs map logarithmically.
  setFilter(v: number) {
    this._filter = Math.max(-1, Math.min(1, v));
    this.applyFilter();
  }

  // FX master: a bypass for the deck's color filter. Off pins it transparent
  // while keeping the knob value, so flipping it back restores the same sweep.
  get fxOn() {
    return this._fxOn;
  }
  setFx(on: boolean) {
    this._fxOn = on;
    this.applyFilter();
  }
  private applyFilter() {
    const f = this.filter;
    const x = this._fxOn ? this._filter : 0;
    if (Math.abs(x) < 0.02) {
      f.type = "lowpass";
      f.frequency.value = 22050;
    } else if (x < 0) {
      f.type = "lowpass";
      f.frequency.value = 22050 * Math.pow(180 / 22050, -x); // 22k → 180 Hz
    } else {
      f.type = "highpass";
      f.frequency.value = 20 * Math.pow(7000 / 20, x); // 20 → 7000 Hz
    }
  }

  // Integrated RMS loudness (linear) of the loaded track, computed once and
  // cached. Sub-sampled — loudness is a slow average, so a stride is plenty and
  // keeps a multi-minute track from blocking. Used by the "dB" gain-match button.
  get loudness(): number {
    if (this._loudness != null) return this._loudness;
    const b = this.buffer;
    if (!b) return 0;
    let sumSq = 0;
    let n = 0;
    const stride = 64;
    for (let c = 0; c < b.numberOfChannels; c++) {
      const d = b.getChannelData(c);
      for (let i = 0; i < d.length; i += stride) {
        sumSq += d[i] * d[i];
        n++;
      }
    }
    this._loudness = n ? Math.sqrt(sumSq / n) : 0;
    return this._loudness;
  }

  // ~5 ms fade in/out around every source start/stop kills the clicks you'd
  // otherwise hear on cue, seek, loop and play/pause — this is most of what makes
  // playback feel "tight" like hardware.
  private static readonly FADE = 0.005;

  private spawnSource(offset: number) {
    if (!this.buffer) return;
    // Never stack a second source group on top of a live one — that's an audible "double
    // play" of the same track. Any stray double-spawn (e.g. a session tick re-playing a
    // deck mid jog-coast) crossfades over the old group instead. play()/seek() already
    // ensure this; this makes it true for EVERY caller.
    if (this.source) this.stopSource();
    const t = this.ctx.currentTime;
    // With a loop active, fold the start point into [start, end) so the source
    // loops cleanly. Starting a looping source at/after loopEnd makes Chrome play
    // offset → buffer end BEFORE wrapping (the "overplay"), and during rapid
    // navigation those leaked tails stack into audible overlap. The clock anchor
    // (startOffset) stays = offset since position() folds it the same way.
    let startAt = offset;
    if (this.loop?.active) {
      const { start, end } = this.loop;
      const len = end - start;
      if (len > 0 && (startAt < start || startAt >= end)) {
        startAt = start + ((((startAt - start) % len) + len) % len);
      }
    }
    // Shared declick envelope for the whole source group (the mix, OR the 4 stems).
    const g = this.ctx.createGain();
    g.connect(this.pitchNode ?? this.eq.input);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(1, t + Deck.FADE);

    const sources: AudioBufferSourceNode[] = [];
    this.curStemGains = {};
    const spawn = (buf: AudioBuffer, dest: AudioNode) => {
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = this._rate;
      if (this.loop?.active) {
        src.loopStart = this.loop.start;
        src.loopEnd = this.loop.end;
        src.loop = true;
      }
      src.connect(dest);
      src.start(0, startAt);
      sources.push(src);
    };

    if (this.stems) {
      // One source per stem, each through its own (live-toggleable) gain, all
      // started together at the same offset + rate so they stay sample-locked.
      for (const name of STEM_NAMES) {
        const sg = this.ctx.createGain();
        sg.gain.value = this.effectiveStemGain(name);
        sg.connect(g);
        this.curStemGains[name] = sg;
        spawn(this.stems[name], sg);
      }
    } else {
      spawn(this.buffer, g);
    }

    const primary = sources[0];
    primary.onended = () => {
      if (primary === this.source) {
        this._playing = false;
        this.startOffset = this.buffer?.duration ?? 0;
        this.onEnded?.();
      }
    };
    this.sources = sources;
    this.source = primary;
    this.srcGain = g;
    this.startOffset = offset;
    this.startedAt = t;
  }

  private stopSource() {
    if (!this.source) return;
    const sources = this.sources;
    const g = this.srcGain;
    const stemGains = this.curStemGains;
    this.sources = [];
    this.source = null;
    this.srcGain = null;
    this.curStemGains = {};
    for (const s of sources) s.onended = null;
    const cleanup = () => {
      for (const s of sources) {
        try {
          s.disconnect();
        } catch {
          /* ignore */
        }
      }
      for (const n of Object.values(stemGains)) {
        try {
          n?.disconnect();
        } catch {
          /* ignore */
        }
      }
      try {
        g?.disconnect();
      } catch {
        /* ignore */
      }
    };
    if (g) {
      // Fade out, then stop just after — the old group overlaps the new one for a
      // few ms, so seeks/loops crossfade instead of clicking.
      const t = this.ctx.currentTime;
      const stopAt = t + Deck.FADE + 0.002;
      try {
        g.gain.cancelScheduledValues(t);
        g.gain.setValueAtTime(g.gain.value, t);
        g.gain.linearRampToValueAtTime(0, t + Deck.FADE);
      } catch {
        /* ignore */
      }
      try {
        sources.forEach((s, i) => {
          s.stop(stopAt);
          if (i === 0) s.onended = cleanup; // one fires; it tears down the whole group
        });
      } catch {
        for (const s of sources) {
          try {
            s.stop();
          } catch {
            /* already stopped */
          }
        }
        cleanup();
      }
    } else {
      for (const s of sources) {
        try {
          s.stop();
        } catch {
          /* already stopped */
        }
      }
      cleanup();
    }
  }
}
