// The sampler's audio engine. It owns nothing about pad assignments or persistence (that's the
// React layer, useSampler.ts) — only voice playback + routing. It is ROUTE-AGNOSTIC: each play()
// carries its own `route` ("A" | "master" | "B"), and the engine just connects the voice to that
// node. The React layer maps the 24 pads to routes (0-7 → master / global, 8-15 → deck A, 16-23 →
// deck B); "A"/"B" land in that deck's channel input (so EQ / filter / fader / crossfader shape
// them), "master" cuts through post-crossfade. A "voice" is one AudioBufferSourceNode; each pad has
// at most one live voice (retrigger replaces it). Deck-region voices pass the deck's own decoded
// buffer with an {offset,duration} window; global voices pass an uploaded/captured clip's buffer.
// See docs/audio-io.md for the full signal flow.

export type SampleMode = "oneshot" | "gate" | "loop" | "bounce";
export type SampleRoute = "A" | "master" | "B";

export interface PlayOpts {
  buffer: AudioBuffer;
  offset?: number; // seconds into the buffer (region start; 0 for a whole file)
  duration?: number; // seconds to play (region length; undefined = to the buffer's end)
  route: SampleRoute;
  mode: SampleMode;
  gain?: number; // 0..1.5 (unity = 1)
  rate?: number; // playback rate (region voices tempo-sync to the deck; default 1 = original)
}

export class Sampler {
  private voices = new Map<number, { src: AudioBufferSourceNode; g: GainNode }>();
  /** Fired when a voice starts or stops (so the UI can light/clear playing pads). */
  onChange: (() => void) | null = null;

  constructor(
    private ctx: AudioContext,
    private routes: Record<SampleRoute, AudioNode>,
  ) {}

  /** Trigger pad `pad`. Retrigger stops the pad's current voice first (re-fire from 0). */
  play(pad: number, o: PlayOpts): void {
    this.stop(pad, true);
    if (this.ctx.state === "suspended") void this.ctx.resume();
    const src = this.ctx.createBufferSource();
    src.buffer = o.buffer;
    if (o.rate && o.rate > 0) src.playbackRate.value = o.rate; // tempo-sync (region voices ride the deck rate)
    const g = this.ctx.createGain();
    g.gain.value = o.gain ?? 1;
    src.connect(g).connect(this.routes[o.route] ?? this.routes.master);
    const start = Math.max(0, Math.min(o.offset ?? 0, o.buffer.duration));
    const len = o.duration && o.duration > 0 ? o.duration : undefined;
    if (o.mode === "bounce") {
      // Ping-pong: loop a [forward ++ reversed] copy of the window so it plays out then back,
      // seamlessly (the mirror makes both folds click-free — the turn samples match).
      src.buffer = Sampler.bounceBuffer(this.ctx, o.buffer, start, len ?? o.buffer.duration - start);
      src.loop = true;
      src.loopStart = 0;
      src.loopEnd = src.buffer.duration;
      src.start(0, 0);
    } else if (o.mode === "loop") {
      src.loop = true;
      src.loopStart = start;
      src.loopEnd = len ? Math.min(o.buffer.duration, start + len) : o.buffer.duration;
      src.start(0, start);
    } else {
      // one-shot / gate play the window once; gate is stopped early on release().
      src.start(0, start, len);
    }
    src.onended = () => {
      const v = this.voices.get(pad);
      if (v && v.src === src) {
        this.voices.delete(pad);
        this.onChange?.();
      }
    };
    this.voices.set(pad, { src, g });
    this.onChange?.();
  }

  /** Gate release — stop the held voice. (No-op for one-shot/loop if already ended.) */
  release(pad: number): void {
    this.stop(pad);
  }

  stop(pad: number, silent = false): void {
    const v = this.voices.get(pad);
    if (!v) return;
    try {
      v.src.onended = null;
      v.src.stop();
    } catch {
      /* already stopped */
    }
    try {
      v.src.disconnect();
      v.g.disconnect();
    } catch {
      /* ignore */
    }
    this.voices.delete(pad);
    if (!silent) this.onChange?.();
  }

  stopAll(): void {
    for (const k of [...this.voices.keys()]) this.stop(k, true);
    this.onChange?.();
  }

  isPlaying(pad: number): boolean {
    return this.voices.has(pad);
  }

  /** Live-adjust a sounding voice's gain (e.g. while held). Short ramp so a live move on a
   *  sounding voice doesn't click. */
  setGain(pad: number, gain: number): void {
    const v = this.voices.get(pad);
    if (v) v.g.gain.setTargetAtTime(gain, this.ctx.currentTime, 0.012);
  }

  /** Live-adjust a sounding voice's playback rate (a region voice following a deck tempo move). */
  setRate(pad: number, rate: number): void {
    const v = this.voices.get(pad);
    if (v && rate > 0) v.src.playbackRate.value = rate;
  }

  /** Build a ping-pong buffer for `bounce` mode: the [startSec, startSec+lenSec) window
   *  followed by its reverse, so looping it plays the slice forward then backward forever.
   *  Both folds are click-free (the mirror repeats the turn sample). */
  private static bounceBuffer(ctx: AudioContext, src: AudioBuffer, startSec: number, lenSec: number): AudioBuffer {
    const sr = src.sampleRate;
    const s0 = Math.max(0, Math.floor(startSec * sr));
    const n = Math.min(src.length - s0, Math.max(1, Math.floor(lenSec * sr)));
    const ch = src.numberOfChannels;
    const out = ctx.createBuffer(ch, n * 2, sr);
    for (let c = 0; c < ch; c++) {
      const inD = src.getChannelData(c);
      const outD = out.getChannelData(c);
      for (let i = 0; i < n; i++) outD[i] = inD[s0 + i]; // forward
      for (let i = 0; i < n; i++) outD[n + i] = inD[s0 + n - 1 - i]; // reversed
    }
    return out;
  }
}
