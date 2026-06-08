import type { Beatgrid } from "./analyze";
import { decodeAudio } from "./decode";
import { Eq3 } from "./Eq3";

// A single deck: source -> EQ3 -> trim gain -> output (into the crossfader).
//
// AudioBufferSourceNode is one-shot, so play/seek/tempo rebuild it; position is
// reconstructed from context time so the playhead stays continuous. The deck
// owns tempo (so Sync can drive it and the UI reflects it), 8 hot cues, and a
// beat-based loop implemented with the source node's native loopStart/loopEnd.

export const HOT_CUE_COUNT = 8;

export interface Loop {
  active: boolean;
  start: number;
  end: number;
  beats: number;
}

export class Deck {
  readonly output: GainNode;
  private readonly eq: Eq3;
  private readonly ctx: AudioContext;

  buffer: AudioBuffer | null = null;
  beatgrid: Beatgrid | null = null;
  private source: AudioBufferSourceNode | null = null;

  private _playing = false;
  private startOffset = 0;
  private startedAt = 0;
  private _rate = 1;
  private _tempo = 0; // percent
  private _keylock = false;
  private pitchNode: AudioWorkletNode | null = null;
  quantizeOn = false; // magnet: snap cues/loops/jumps to the beatgrid
  cuePoint = 0;
  hotCues: (number | null)[] = new Array(HOT_CUE_COUNT).fill(null);
  loop: Loop | null = null;
  loopInPoint: number | null = null; // pending manual loop-in (FLX4 style)

  onEnded?: () => void;

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.eq = new Eq3(ctx);
    this.output = ctx.createGain();
    this.eq.output.connect(this.output);
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
  get keylock() {
    return this._keylock;
  }

  /** Insert the key-lock pitch-shifter between the source and EQ. */
  attachPitchNode(node: AudioWorkletNode) {
    node.connect(this.eq.input);
    this.pitchNode = node;
    this.updatePitch();
    // Re-route a currently-playing source through the new node.
    if (this.source) {
      try {
        this.source.disconnect();
      } catch {
        /* ignore */
      }
      this.source.connect(node);
    }
  }

  setKeylock(on: boolean) {
    this._keylock = on;
    this.updatePitch();
  }

  // ratio = 1/rate cancels the source's pitch shift; ratio = 1 is transparent.
  private updatePitch() {
    if (!this.pitchNode) return;
    const ratio = this._keylock ? 1 / this._rate : 1;
    this.pitchNode.parameters.get("ratio")!.value = ratio;
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
    this.loop = null;
    this.loopInPoint = null;
    this.buffer = buffer;
    this.beatgrid = beatgrid;
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
    if (!this.buffer || this._playing) return;
    this.spawnSource(this.startOffset);
    this._playing = true;
  }
  pause() {
    if (!this._playing) return;
    this.startOffset = this.position();
    this.stopSource();
    this._playing = false;
  }
  togglePlay() {
    this._playing ? this.pause() : this.play();
  }

  seek(seconds: number) {
    const target = Math.max(0, Math.min(this.duration, seconds));
    if (this._playing) {
      this.stopSource();
      this.spawnSource(target);
    } else {
      this.startOffset = target;
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
    if (this.source) this.source.playbackRate.value = rate;
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
    const cur = this.hotCues[i];
    if (cur == null) this.hotCues[i] = this.maybeSnap(this.position());
    else this.seek(cur);
  }
  clearHotCue(i: number) {
    this.hotCues[i] = null;
  }

  // --- loops ---
  /** Set + enable a loop of `beats` length, snapped to the beatgrid. */
  setBeatLoop(beats: number) {
    if (!this.buffer) return;
    const interval = this.beatgrid?.interval ?? 60 / 120;
    const start = this.beatgrid ? this.snap(this.position()) : this.position();
    const end = Math.min(this.duration, start + beats * interval);
    this.loop = { active: true, start, end, beats };
    this.applyLoop();
    if (this._playing) {
      const pos = this.position();
      if (pos < start || pos > end) this.seek(start);
    }
  }

  // FLX4-style manual loop: tap IN to drop the entry point, tap OUT to set the
  // exit and start looping, EXIT to leave, RELOOP to jump back in.
  loopIn() {
    this.loopInPoint = this.maybeSnap(this.position());
  }
  loopOut() {
    if (this.loopInPoint == null) return;
    const start = this.loopInPoint;
    const end = this.maybeSnap(this.position());
    this.loopInPoint = null;
    if (end <= start) return;
    const interval = this.beatgrid?.interval ?? 60 / 120;
    this.loop = { active: true, start, end, beats: Math.max(1, Math.round((end - start) / interval)) };
    this.applyLoop();
  }
  reloop() {
    if (!this.loop) return;
    this.loop.active = true;
    this.applyLoop();
    this.seek(this.loop.start);
  }

  toggleLoop() {
    if (!this.loop) return;
    this.loop.active = !this.loop.active;
    this.applyLoop();
  }
  exitLoop() {
    if (!this.loop) return;
    this.loop.active = false;
    this.applyLoop();
  }

  private applyLoop() {
    if (!this.source) return;
    if (this.loop?.active) {
      this.source.loopStart = this.loop.start;
      this.source.loopEnd = this.loop.end;
      this.source.loop = true;
    } else {
      this.source.loop = false;
    }
  }

  // --- EQ / trim ---
  setTrim(gain: number) {
    this.output.gain.value = gain;
  }
  setEqLow(db: number) {
    this.eq.setLow(db);
  }
  setEqMid(db: number) {
    this.eq.setMid(db);
  }
  setEqHigh(db: number) {
    this.eq.setHigh(db);
  }

  private spawnSource(offset: number) {
    if (!this.buffer) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.playbackRate.value = this._rate;
    src.connect(this.pitchNode ?? this.eq.input);
    src.onended = () => {
      if (src === this.source) {
        this._playing = false;
        this.startOffset = this.buffer?.duration ?? 0;
        this.onEnded?.();
      }
    };
    this.source = src;
    if (this.loop?.active) {
      src.loopStart = this.loop.start;
      src.loopEnd = this.loop.end;
      src.loop = true;
    }
    src.start(0, offset);
    this.startOffset = offset;
    this.startedAt = this.ctx.currentTime;
  }

  private stopSource() {
    if (!this.source) return;
    const src = this.source;
    this.source = null;
    try {
      src.onended = null;
      src.stop();
    } catch {
      /* already stopped */
    }
    src.disconnect();
  }
}
