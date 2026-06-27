// Internal beat clock — the single source of truth for note timing.
//
// Deliberately decoupled from the audio waveform. Effect House's Beats Detection
// node carries a documented ~2s accuracy delay and only emits a coarse 1-2-3-4
// measure index, so it can never drive hit-timing. The game is music-agnostic:
// notes fall on THIS clock; the user's TikTok track is backing vibe, not a sync
// target. advance() is driven by the component's onUpdate(deltaTime).

export class GameClock {
  /** seconds since the round started */
  time = 0;
  /** beats per minute — seeds the grid; can be set by a tap-tempo intro */
  bpm: number;
  /** seconds; the effect-time of "beat 0" */
  beatPhase: number;

  constructor(bpm = 120, beatPhase = 0) {
    this.bpm = bpm;
    this.beatPhase = beatPhase;
  }

  get beatPeriod(): number {
    return 60 / this.bpm;
  }

  advance(dt: number): void {
    this.time += dt;
  }

  /** effect-time at which a given beat index should be hit */
  targetTimeOf(beatIndex: number): number {
    return this.beatPhase + beatIndex * this.beatPeriod;
  }
}
