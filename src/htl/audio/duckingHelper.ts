// Waveshaper transfer curves for the FX ducking sidechain (envelope follower → wet gain).
// These were byte-identical copies in DelayFx.ts and ReverbFx.ts; one home now.

/** |x| rectifier for the ducking envelope follower. */
export function makeRectifyCurve(): Float32Array<ArrayBuffer> {
  const n = 1024;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) curve[i] = Math.abs((i / (n - 1)) * 2 - 1);
  return curve;
}

/**
 * Clamp the (boosted) envelope to [0,1] so the duck can't drive the wet gain negative —
 * inputs beyond ±1 hold the endpoint value (1), so it saturates instead of inverting.
 */
export function makeClampCurve(): Float32Array<ArrayBuffer> {
  const n = 1024;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.max(0, Math.min(1, x));
  }
  return curve;
}

/** ★ THE DUCK TAP'S OWN GATE — one implementation, because two identical ones drift.
 *
 *  DelayFx and ReverbFx tap `duckScale` with an AnalyserNode so the UI can read the real duck
 *  depth off the SIGNAL (seriesDuck.gain.value is structurally blind to .connect()-ed modulation).
 *  An AnalyserNode is a PATH: everything upstream of it stays scheduled, and that tap is on the
 *  sidechain side where BaseFxDevice's wet gate never looks. So the follower ran for the life of
 *  the device — bypassed, and even with duck at zero, where both its ends are already severed.
 *
 *  Measured at 26.4% of a DelayFx's whole active cost (fxlab --duck-cost, 9326968), against a
 *  written judgement that called it "orders below" the delay lines. The edge is only severable
 *  from the SOURCE — an analyser has no outputs — which this owns so no caller can get it wrong. */
/** ★ THE CONDITION, EXTRACTED SO IT CAN BE PINNED AND SO TWO DEVICES CANNOT DRIFT ON IT.
 *
 *  The tap is live only while BOTH halves hold, and each half was found separately and at cost:
 *
 *  GATE OPEN — because the bypass gate cuts edges out of `wet` and the tap hangs off `duckScale`,
 *  on the sidechain side, where the gate never looks. Measured at 26.4% of a DelayFx's whole active
 *  cost (fxlab --duck-cost); a bypassed delay went from 33.7% of active to 7.4% once this half was
 *  added. Drop it and a bypassed device pays a quarter of its cost to feed a meter nobody reads.
 *
 *  FOLLOWER WIRED — because setDuck already severs BOTH ends of the follower when duck reaches 0,
 *  and the tap alone kept all five native nodes scheduled anyway. This half is the one nobody
 *  predicted: the cost was there at duck ZERO, where the feature is off.
 *
 *  Either half alone leaves one of those two regressions. Written as a named predicate rather than
 *  an && at two call sites, because the reasons above are what a later simplification discards. */
export function duckTapWanted(gateOpen: boolean, followerWired: boolean): boolean {
  return gateOpen && followerWired;
}

export class DuckTap {
  private wired = true; // both devices connect the tap in their constructor
  constructor(
    private readonly from: AudioNode,
    private readonly to: AnalyserNode,
  ) {}
  /** Idempotent: `want` is the whole truth, and a repeat costs nothing. */
  sync(want: boolean) {
    if (want === this.wired) return;
    if (want) this.from.connect(this.to);
    else
      try {
        this.from.disconnect(this.to);
      } catch {
        /* already gone */
      }
    this.wired = want;
  }
  /** False while the tap is cut — a meter read through it would be reporting a severed path. */
  get on(): boolean {
    return this.wired;
  }
}
