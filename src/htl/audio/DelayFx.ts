// Delay / echo — the classic DJ feedback delay. A single delay line with a damped
// feedback loop, wet-mixed on top of the dry signal:
//
//   input ─┬─→ dry ────────────────────────────→ output
//          └─→ delay ─→ tone(LP) ─┬─→ wet ──────→ output
//                         ▲        └─→ feedback ──┐
//                         └────────────────────────┘
//
// The tone lowpass sits INSIDE the feedback loop so each successive echo gets darker
// (analog-ish tape/BBD decay) instead of a harsh digital repeat. `time` is in seconds
// but is meant to be driven from the deck BPM (UI computes beat-divisions → seconds),
// so echoes lock to the grid. Params: time · feedback · tone · mix (mix from the base).

import { BaseFxDevice, type FxKind } from "./Fx";

export const DELAY_MAX_SECONDS = 2.0; // covers a whole bar at ≥120 BPM (2s = 1 bar @ 120)

export class DelayFx extends BaseFxDevice {
  readonly kind: FxKind = "delay";
  private readonly delay: DelayNode;
  private readonly feedback: GainNode;
  private readonly tone: BiquadFilterNode;
  // UI metadata (no direct audio effect): whether `time` is beat-locked and which note
  // division it tracks. Stored as params so they persist in profiles and ride the session
  // sync for free — the panel reads them to recompute `time` (seconds) from the deck BPM.
  private _sync = 1; // 1 = beat-locked, 0 = free ms
  private _div = 2; // index into the panel's division table (default 1/8)

  constructor(ctx: AudioContext) {
    super(ctx, 0.28); // a touch under a third wet by default — present but not washing the mix

    this.delay = ctx.createDelay(DELAY_MAX_SECONDS);
    this.delay.delayTime.value = 0.375; // 3/8-note feel at 120 BPM until the UI sets it from BPM

    this.tone = ctx.createBiquadFilter();
    this.tone.type = "lowpass";
    this.tone.frequency.value = 6500; // darken the repeats

    this.feedback = ctx.createGain();
    this.feedback.gain.value = 0.38;

    // input → delay → tone → wet; tone → feedback → delay (the regenerating loop).
    this.input.connect(this.delay);
    this.delay.connect(this.tone);
    this.tone.connect(this.wet);
    this.tone.connect(this.feedback);
    this.feedback.connect(this.delay);

    this.params.push(
      {
        id: "time",
        def: 0.375,
        get: () => this.delay.delayTime.value,
        // glide the time a little so a live division change bends pitch instead of clicking
        set: (v) => this.delay.delayTime.setTargetAtTime(clamp(v, 0.001, DELAY_MAX_SECONDS), this.ctx.currentTime, 0.02),
      },
      {
        id: "feedback",
        def: 0.38,
        // capped < 1 so it always decays — no runaway self-oscillation
        get: () => this.feedback.gain.value,
        set: (v) => this.feedback.gain.setTargetAtTime(clamp(v, 0, 0.92), this.ctx.currentTime, 0.01),
      },
      {
        id: "tone",
        def: 6500,
        get: () => this.tone.frequency.value,
        set: (v) => this.tone.frequency.setTargetAtTime(clamp(v, 200, 18000), this.ctx.currentTime, 0.02),
      },
      // metadata params (persist + sync; the panel turns them into `time`)
      { id: "sync", def: 1, get: () => this._sync, set: (v) => (this._sync = v ? 1 : 0) },
      { id: "div", def: 2, get: () => this._div, set: (v) => (this._div = Math.round(v)) },
    );
  }
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}
