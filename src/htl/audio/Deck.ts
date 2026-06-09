import type { Beatgrid } from "../analysis/analyze";
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
  readonly output: GainNode; // channel level fader (feeds the crossfader)
  private readonly trimNode: GainNode;
  private readonly eq: Eq3;
  private readonly filter: BiquadFilterNode; // single-knob HP/LP color filter
  private readonly ctx: AudioContext;
  private _trim = 1;
  private _level = 1;
  private _eqLow = 0;
  private _eqMid = 0;
  private _eqHigh = 0;
  private _filter = 0; // -1 full low-pass … 0 off … +1 full high-pass

  buffer: AudioBuffer | null = null;
  beatgrid: Beatgrid | null = null;
  private source: AudioBufferSourceNode | null = null;
  private srcGain: GainNode | null = null; // per-source declick envelope

  private _playing = false;
  private startOffset = 0;
  private startedAt = 0;
  private _rate = 1;
  private _tempo = 0; // percent
  private _keylock = false;
  private pitchNode: AudioWorkletNode | null = null;
  quantizeOn = false; // magnet: snap cues/loops/jumps to the beatgrid
  private _scrubbing = false;
  private _wasPlaying = false;
  private _reversed: AudioBuffer | null = null;
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
    this.hotLoops = new Array(HOT_CUE_COUNT).fill(null);
    this.loop = null;
    this.loopInPoint = null;
    this._reversed = null;
    this._scrubbing = false;
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

  // --- scrubbing (jog-wheel / vinyl feel) ---
  get scrubbing() {
    return this._scrubbing;
  }
  scrubBegin() {
    if (this._scrubbing) return;
    this._wasPlaying = this._playing;
    if (this._playing) this.pause();
    this._scrubbing = true;
  }
  /** Move by deltaSec of track time; plays the swept audio at drag velocity. */
  scrubMove(deltaSec: number) {
    if (!this._scrubbing || !this.buffer) return;
    const from = this.startOffset;
    const to = Math.max(0, Math.min(this.buffer.duration, from + deltaSec));
    this.playScrubGrain(from, to);
    this.startOffset = to;
  }
  scrubEnd() {
    if (!this._scrubbing) return;
    this._scrubbing = false;
    if (this._wasPlaying) this.play();
  }

  private reversed(): AudioBuffer {
    if (this._reversed) return this._reversed;
    const b = this.buffer!;
    const rev = this.ctx.createBuffer(b.numberOfChannels, b.length, b.sampleRate);
    for (let c = 0; c < b.numberOfChannels; c++) {
      const src = b.getChannelData(c);
      const dst = rev.getChannelData(c);
      for (let i = 0, n = b.length; i < n; i++) dst[i] = src[n - 1 - i];
    }
    this._reversed = rev;
    return rev;
  }

  // Play the [from,to] slice over ~one event interval, so faster drags pitch up
  // (forward = normal buffer, backward = reversed buffer) — the vinyl scrub sound.
  private playScrubGrain(from: number, to: number) {
    if (!this.buffer) return;
    const len = to - from;
    const aLen = Math.abs(len);
    if (aLen < 1e-4) return;
    const GRAIN = 0.022;
    const rate = Math.max(0.06, Math.min(8, aLen / GRAIN));
    const realDur = aLen / rate;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    const env = this.ctx.createGain();
    src.connect(env);
    env.connect(this.eq.input);
    src.playbackRate.value = rate;
    let offset: number;
    if (len >= 0) {
      src.buffer = this.buffer;
      offset = from;
    } else {
      src.buffer = this.reversed();
      offset = this.buffer.duration - from;
    }
    offset = Math.max(0, Math.min(this.buffer.duration - 0.001, offset));
    const a = Math.min(0.004, realDur * 0.3);
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(1, t + a);
    env.gain.setValueAtTime(1, Math.max(t + a, t + realDur - a));
    env.gain.linearRampToValueAtTime(0, t + realDur);
    try {
      src.start(t, offset, aLen);
      src.stop(t + realDur + 0.03);
    } catch {
      /* offset out of range */
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
    if (this.source) {
      // Glide the rate so fader moves bend the pitch smoothly instead of stepping.
      const t = this.ctx.currentTime;
      const p = this.source.playbackRate;
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
    const x = Math.max(-1, Math.min(1, v));
    this._filter = x;
    const f = this.filter;
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

  // ~5 ms fade in/out around every source start/stop kills the clicks you'd
  // otherwise hear on cue, seek, loop and play/pause — this is most of what makes
  // playback feel "tight" like hardware.
  private static readonly FADE = 0.005;

  private spawnSource(offset: number) {
    if (!this.buffer) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.playbackRate.value = this._rate;
    const g = this.ctx.createGain();
    src.connect(g);
    g.connect(this.pitchNode ?? this.eq.input);
    const t = this.ctx.currentTime;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(1, t + Deck.FADE);
    src.onended = () => {
      if (src === this.source) {
        this._playing = false;
        this.startOffset = this.buffer?.duration ?? 0;
        this.onEnded?.();
      }
    };
    this.source = src;
    this.srcGain = g;
    if (this.loop?.active) {
      src.loopStart = this.loop.start;
      src.loopEnd = this.loop.end;
      src.loop = true;
    }
    src.start(0, offset);
    this.startOffset = offset;
    this.startedAt = t;
  }

  private stopSource() {
    if (!this.source) return;
    const src = this.source;
    const g = this.srcGain;
    this.source = null;
    this.srcGain = null;
    src.onended = null;
    if (g) {
      // Fade out, then stop just after — the old source overlaps the new one for
      // a few ms, so seeks/loops crossfade instead of clicking.
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
        src.stop(stopAt);
        src.onended = () => {
          try {
            src.disconnect();
            g.disconnect();
          } catch {
            /* ignore */
          }
        };
      } catch {
        try {
          src.stop();
        } catch {
          /* already stopped */
        }
        src.disconnect();
        g.disconnect();
      }
    } else {
      try {
        src.stop();
      } catch {
        /* already stopped */
      }
      src.disconnect();
    }
  }
}
