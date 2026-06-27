// Gesture detection = pure signal processing over a scalar fed each frame.
//
// Each detector takes ONE scalar per frame (head pitch, hand-centre X, etc),
// low-passes it to kill tracker jitter, and fires a single debounced event at a
// velocity peak. The component layer is responsible only for sourcing the scalar
// from APJS.AlgorithmManager — all the logic lives here and is unit-testable in
// plain Node with no Effect House runtime.

export type GestureType = "headBop" | "crossfader" | "filter" | "drop";

export interface GestureEvent {
  type: GestureType;
  /** effect-time of the motion peak, already LATENCY_OFFSET-corrected */
  tEvent: number;
  /** raw peak velocity magnitude — Style score reads this (bigger = more style) */
  amplitude: number;
}

export interface PeakOpts {
  /** EMA smoothing factor 0..1 (higher = snappier, noisier). ~0.4 is a good start. */
  lowPass: number;
  /** sign of the velocity peak we care about: -1 = downward (head bop), +1 = up */
  direction: 1 | -1;
  /** minimum |velocity| (signal units / second) to count as a real move */
  velThresh: number;
  /** refractory window (s) so one move != many events */
  refractory: number;
  /** fixed LATENCY_OFFSET (s) applied to tEvent — tune on device, err generous */
  latency: number;
}

export class PeakDetector {
  private smoothed = 0;
  private vel = 0;
  private inited = false;
  private rising = false;
  private peakVel = 0;
  private lastFire = -Infinity;

  constructor(
    readonly type: GestureType,
    private readonly opts: PeakOpts,
  ) {}

  /**
   * Feed the current scalar + clock time + frame dt. Returns a GestureEvent at
   * the frame where directional velocity crests past threshold, else null.
   */
  feed(signal: number, t: number, dt: number): GestureEvent | null {
    if (!this.inited) {
      this.smoothed = signal;
      this.inited = true;
      return null;
    }
    if (dt <= 0) return null;

    const prev = this.smoothed;
    this.smoothed += this.opts.lowPass * (signal - this.smoothed);
    const v = (this.smoothed - prev) / dt;
    const dirV = v * this.opts.direction; // positive when moving the way we want

    // Track the crest: while accelerating in-direction past threshold, remember
    // the largest velocity; fire when it rolls over (velocity starts dropping).
    if (dirV > this.opts.velThresh) {
      this.rising = true;
      if (dirV > this.peakVel) this.peakVel = dirV;
      this.vel = v;
      return null;
    }

    if (this.rising) {
      // velocity fell back under threshold -> we just passed the peak
      this.rising = false;
      const amplitude = this.peakVel;
      this.peakVel = 0;
      if (t - this.lastFire >= this.opts.refractory) {
        this.lastFire = t;
        return { type: this.type, tEvent: t + this.opts.latency, amplitude };
      }
    }
    return null;
  }
}
