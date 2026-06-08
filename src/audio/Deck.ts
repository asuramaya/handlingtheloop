import { Eq3 } from "./Eq3";

// A single deck: source -> EQ3 -> trim gain -> output.
// The engine connects `output` into the crossfader.
//
// AudioBufferSourceNode is one-shot, so every play/seek/tempo change rebuilds
// the source. Position is reconstructed from context time so the playhead stays
// continuous across those rebuilds.
//
// Tempo note (MVP): tempo is applied via playbackRate, so pitch tracks tempo
// like vinyl ("vinyl mode"). True key-lock needs a time-stretch stage
// (SoundTouch / Rubber Band WASM) slotted between source and EQ — the graph is
// shaped to accept it without touching the rest of the deck.

export class Deck {
  readonly output: GainNode; // trim/channel gain, fed into the crossfader
  private readonly eq: Eq3;
  private readonly ctx: AudioContext;

  buffer: AudioBuffer | null = null;
  private source: AudioBufferSourceNode | null = null;

  private _playing = false;
  private startOffset = 0; // seconds into the track at the current segment start
  private startedAt = 0; // ctx.currentTime when the current segment started
  private _rate = 1; // playbackRate = 1 + tempo%
  cuePoint = 0;

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

  async loadArrayBuffer(data: ArrayBuffer) {
    this.stopSource();
    this._playing = false;
    this.startOffset = 0;
    this.cuePoint = 0;
    // decodeAudioData detaches the buffer, so hand it a copy.
    this.buffer = await this.ctx.decodeAudioData(data.slice(0));
  }

  /** Current playhead position in seconds. */
  position(): number {
    if (!this.buffer) return 0;
    const pos = this._playing
      ? this.startOffset + (this.ctx.currentTime - this.startedAt) * this._rate
      : this.startOffset;
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

  /** tempoPercent in e.g. [-8, +8] -> playbackRate around 1. */
  setTempo(tempoPercent: number) {
    const rate = 1 + tempoPercent / 100;
    if (this._playing) {
      // Rebase so the playhead stays continuous through the rate change.
      this.startOffset = this.position();
      this.startedAt = this.ctx.currentTime;
    }
    this._rate = rate;
    if (this.source) this.source.playbackRate.value = rate;
  }

  /** rekordbox-style cue: store the cue point at the current position. */
  setCue() {
    this.cuePoint = this.position();
  }

  jumpToCue() {
    this.seek(this.cuePoint);
  }

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
    src.connect(this.eq.input);
    src.onended = () => {
      // Fired on both natural end and manual stop; ignore manual stops.
      if (src === this.source) {
        this._playing = false;
        this.startOffset = this.buffer?.duration ?? 0;
        this.onEnded?.();
      }
    };
    src.start(0, offset);
    this.source = src;
    this.startOffset = offset;
    this.startedAt = this.ctx.currentTime;
  }

  private stopSource() {
    if (!this.source) return;
    const src = this.source;
    this.source = null; // detach first so onended ignores this stop
    try {
      src.onended = null;
      src.stop();
    } catch {
      /* already stopped */
    }
    src.disconnect();
  }
}
