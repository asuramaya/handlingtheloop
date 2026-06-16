// The sampler strip's audio engine. It owns nothing about pad assignments or
// persistence (that's the React layer) — only voice playback + routing. The 12-pad
// strip maps to three routes by position: pads 0-3 → deck A's channel input (so EQ /
// filter / fader / crossfader shape them), 4-7 → master (global, cuts through), 8-11 →
// deck B's channel. A "voice" is one AudioBufferSourceNode; each pad has at most one
// live voice (retrigger replaces it). Deck-region pads pass the deck's own decoded
// buffer with an {offset,duration} window; global pads pass an uploaded clip's buffer.

export type SampleMode = "oneshot" | "gate" | "loop";
export type SampleRoute = "A" | "master" | "B";

export interface PlayOpts {
  buffer: AudioBuffer;
  offset?: number; // seconds into the buffer (region start; 0 for a whole file)
  duration?: number; // seconds to play (region length; undefined = to the buffer's end)
  route: SampleRoute;
  mode: SampleMode;
  gain?: number; // 0..1.5 (unity = 1)
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
    const g = this.ctx.createGain();
    g.gain.value = o.gain ?? 1;
    src.connect(g).connect(this.routes[o.route] ?? this.routes.master);
    const start = Math.max(0, Math.min(o.offset ?? 0, o.buffer.duration));
    const len = o.duration && o.duration > 0 ? o.duration : undefined;
    if (o.mode === "loop") {
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

  /** Live-adjust a sounding voice's gain (e.g. while held). */
  setGain(pad: number, gain: number): void {
    const v = this.voices.get(pad);
    if (v) v.g.gain.value = gain;
  }
}
