// Trance GATE — a tempo-synced rhythmic amplitude gate (the Gross Beat / trance-gate /
// stutter family). NATIVE Web Audio (no worklet): a PHASE RAMP feeds a `WaveShaperNode` that
// maps phase to the gate WINDOW (shape + duty + smooth), and the window — scaled by DEPTH and
// lifted by a (1−depth) floor — drives the gain of a single insert `GainNode`. So the audio is
// ducked rhythmically, locked to the deck's beat.
//
//   input ─────────────────────→ gate ──────────────→ wet ─(mix)→ output
//                                  ▲.gain = (1−depth) + depth·window(phase)
//   phaseRamp(−1..1 saw) → shaper(window 0..1) → depthGain(×depth) ─┘
//   floorConst(1−depth) ───────────────────────────────────────────┘
//
// A real INSERT (dry/wet crossfade like the saturator), free when bypassed via the wet gate.
// The window curve regenerates only on shape/duty/smooth change; depth is a live AudioParam ramp.
// RATE is a musical division synced to `effectiveBpm`, or a free Hz rate when SYNC is off.
//
// ★ SYNC MATCHED THE RATE AND NOTHING ELSE — THE GATE LANDED WHEREVER.
// The phase source used to be a sawtooth `OscillatorNode` started ONCE, at device construction:
// its zero crossing sat wherever ctx.currentTime happened to be when the FX slot was built, and
// the device never saw the playhead, the downbeat, or the bar at all. Right speed, arbitrary
// offset — a trance gate that isn't on the grid, which is the entire point of a trance gate.
// Worse, it DRIFTED: every tempo change glides `frequency` with setTargetAtTime, and a frequency
// glide integrates into a permanent phase error, so even a lucky start would not have held.
//
// Web Audio cannot set an oscillator's phase, so the phase source had to change. It's a
// `ConstantSourceNode` now, whose `offset` is SCHEDULED cycle by cycle from a lookahead
// (setValueAtTime(−1) → linearRampToValueAtTime(1), the WaveShaper's own input domain) — which means any cycle's start can be placed
// on the grid without swapping a node. `setGrid()` feeds the ctx-time of a bar line and the bar's
// length in ctx seconds, derived by the panel from `deck.beatgrid`: THE SAME grid the waveform
// draws, so "on the beat" means on the line you can see.
//
// ★ AND IT CATCHES UP — IT NEVER JUMPS. Snapping the phase to the grid when the effect engages
// (or after a seek, a nudge, a tempo move) is a discontinuity in the gain envelope: an audible
// skip at exactly the moment you switch the thing on. Instead each scheduled cycle is stretched
// or squeezed by at most PULL_MAX of its length toward where the grid says it belongs, so the
// gate walks onto the beat within a bar or two and the correction is never a step. The same
// choice the sync engine makes for tempo: pull, don't jump.
import { BaseFxDevice, type FxKind } from "./Fx";
import { clamp, clamp01, logMap, SyncRate, GATE_DIVS } from "./fxDsp";

export const GATE_SHAPES = ["SQUARE", "PLUCK", "RAMP", "TRI", "SINE"] as const;
export type GateShape = (typeof GATE_SHAPES)[number];

const CURVE_LEN = 2048;
const gateFreeHz = logMap(0.2, 20); // free-mode RATE: 0.2‥20 Hz

// The gate WINDOW as a function of phase p∈[0,1): 0 = closed (ducked), 1 = open (full). `duty`
// is the open fraction; `smooth` rounds the edges (raised-cosine) so steps don't click. Each
// shape gives a different rhythmic feel — the hard square stutter, the trance "pluck" decay,
// ramps, triangle, and a smooth sine swell.
function windowShape(p: number, shape: number, duty: number, smooth: number): number {
  const d = clamp(duty, 0.04, 0.98);
  const s = clamp(smooth, 0, 1) * 0.5 * d + 0.0008; // ramp width (fraction of the open window)
  switch (shape) {
    case 1: {
      // PLUCK — full at the attack, decays to 0 across the open window (the classic trance pluck).
      if (p >= d) return 0;
      const env = 1 - p / d;
      const atk = p < s ? p / s : 1; // tame the attack click when smooth > 0
      return env * atk;
    }
    case 2: {
      // RAMP — swells 0→1 across the open window, then snaps shut.
      if (p >= d) return 0;
      return p / d;
    }
    case 3: {
      // TRI — rises to a peak at the centre of the open window, falls back.
      if (p >= d) return 0;
      const t = p / d;
      return 1 - Math.abs(t - 0.5) * 2;
    }
    case 4: {
      // SINE — a smooth half-sine swell within the open window.
      if (p >= d) return 0;
      return Math.sin((p / d) * Math.PI);
    }
    default: {
      // SQUARE — open across the duty window with raised-cosine edges (smooth = edge softness).
      if (p < s) return 0.5 - 0.5 * Math.cos((Math.PI * p) / s); // rise
      if (p < d - s) return 1;
      if (p < d) return 0.5 + 0.5 * Math.cos((Math.PI * (p - (d - s))) / s); // fall
      return 0;
    }
  }
}

/**
 * How long the cycle starting at `start` should be, to walk toward a grid whose slots sit every
 * `period` from `origin`. Returns the length AND the phase error it was correcting (in cycles,
 * signed, + = the cycle started late).
 *
 * Pure, and exported, because this is the whole alignment behaviour and it is the one part worth
 * testing without an AudioContext: the error must take the SHORT way round (never drag a cycle
 * most of the way around the clock to reach a slot that is 2% behind it), the correction must be
 * clamped so no single cycle is audibly stretched, and a cycle that is already on the grid must
 * come back exactly `period` — an alignment that keeps nudging a locked gate is a wobble.
 */
export function gateCycleLength(start: number, origin: number, period: number, pullMax: number): { len: number; err: number } {
  if (!(period > 0)) return { len: period, err: 0 };
  let err = (start - origin) % period;
  if (err < 0) err += period;
  if (err > period / 2) err -= period; // signed, shortest path
  const pull = clamp(err, -period * pullMax, period * pullMax);
  return { len: period - pull, err: err / period };
}

function makeWindowCurve(shape: number, duty: number, smooth: number) {
  const c = new Float32Array(CURVE_LEN);
  for (let i = 0; i < CURVE_LEN; i++) c[i] = clamp01(windowShape(i / (CURVE_LEN - 1), shape, duty, smooth));
  return c;
}

export class GateFx extends BaseFxDevice {
  readonly kind: FxKind = "gate";

  private readonly gate: GainNode; // the insert VCA — its .gain is the gate envelope
  private readonly phaseRamp: ConstantSourceNode; // −1..1 saw = the phase source (scheduled, see tick)
  private readonly shaper: WaveShaperNode; // phase → window (0..1)
  private readonly depthGain: GainNode; // window × depth
  private readonly floorConst: ConstantSourceNode; // (1 − depth) floor

  // RATE = a tempo-synced division (default) or a free 0.2‥20 Hz knob; synced Hz clamped 0.05‥80.
  private readonly rate = new SyncRate(GATE_DIVS, gateFreeHz, 0.05, 80, 0.2);
  private _depth = 0.85;
  private _duty = 0.5;
  private _smooth = 0.15;
  private _shape = 0;
  private _align = true; // phase-lock the cycle to the deck's bar grid
  private _shift = 0; // 0..1 — where in the CYCLE the grid line falls (0.5 = the offbeat gate)

  // --- the scheduler ---------------------------------------------------------
  // `cycleAt` is the ctx time the NEXT unscheduled cycle starts; everything before it is already
  // written into the AudioParam timeline and must not be rewritten (that's the splice we're
  // avoiding). tick() is driven by setGrid/setSyncBpm, which the panel calls every frame.
  private cycleAt = 0;
  private grid: { at: number; bar: number; beatsPerBar: number } | null = null; // ctx time of a bar line, bar length (ctx sec), beats in it
  private phaseAtCycle = 0; // bookkeeping for the viz: the grid phase the last cycle started on
  private lastErr = 0; // last phase error in cycles (viz: how far off the beat we still are)
  private timer: number | undefined; // the self-drive interval (realtime contexts only)

  constructor(ctx: AudioContext) {
    super(ctx, 1.0); // insert: full wet by default
    this.gate = ctx.createGain();
    this.gate.gain.value = 0; // intrinsic 0 — the floor + depthGain SUM into it
    this.shaper = ctx.createWaveShaper();
    this.depthGain = ctx.createGain();
    this.floorConst = ctx.createConstantSource();
    // The phase source. A ConstantSource, not an Oscillator, precisely because its value is
    // SCHEDULED: an oscillator's phase is unreachable, and this one's is whatever we write.
    this.phaseRamp = ctx.createConstantSource();
    this.phaseRamp.offset.value = -1;
    this.rate.setSync(true); // GATE defaults to beat-synced

    // window envelope → gate.gain
    this.phaseRamp.connect(this.shaper).connect(this.depthGain).connect(this.gate.gain);
    this.floorConst.connect(this.gate.gain);
    // audio insert: input → gate → wet
    this.input.connect(this.gate).connect(this.wet);

    this.refreshCurve();
    this.applyDepth();
    this.applyFreq();
    this.applyDry();
    this.floorConst.start();
    this.phaseRamp.start();
    this.cycleAt = ctx.currentTime;
    this.tick();
    // ★ THE SCHEDULER DRIVES ITSELF. It used to be topped up only by setGrid/setSyncBpm — which
    // the GATE PANEL calls, and the panel is only mounted while its tab is open. Close the tab
    // and the gate would keep whatever gain the last ramp ended on, forever: an effect that stops
    // being an effect because nobody is looking at it. A device's own timeline is the device's
    // own job. (Offline contexts write the whole render above and need no timer.)
    if (!(this.ctx as unknown as { length?: number }).length) {
      this.timer = globalThis.setInterval(() => this.tick(), 100) as unknown as number;
    }
    this.registerParams();
  }

  // ---- the phase scheduler -------------------------------------------------
  // How far ahead cycles are written. Long enough to survive a stalled rAF (a hidden tab, a
  // GC pause), short enough that a RATE change takes effect within a beat or so — anything
  // already written is honoured, because rewriting it is the splice.
  private static readonly LOOKAHEAD = 0.35;
  // The most a single cycle may be stretched/squeezed to chase the grid, as a fraction of its
  // own length. 12% is under the ~5% that reads as a tempo wobble on a sustained tone, but still
  // converges a worst-case half-cycle error in ~4 cycles.
  private static readonly PULL_MAX = 0.12;

  /** Write any cycles that fall inside the lookahead. Idempotent — safe to call every frame. */
  private tick() {
    const now = this.ctx.currentTime;
    // ★ AN OFFLINE RENDER HAS NO WALL CLOCK, so nothing can top the schedule up mid-render: the
    // whole render is written in one go instead. Without this the gate freezes 0.35 s into every
    // fxlab render (found exactly that way — the click metric went to 1e8 because a frozen gate
    // has a median step of zero, and every ratio against it explodes).
    const offlineLen = (this.ctx as unknown as { length?: number }).length;
    const until = offlineLen ? offlineLen / this.ctx.sampleRate : now + GateFx.LOOKAHEAD;
    // ★ An offline render writes the WHOLE timeline in one pass (there is no clock to top it up),
    // which means anything scheduled at construction would ignore every parameter set afterwards —
    // a grid, a rate, an align flag. Offline, therefore, each tick REWRITES from now; before the
    // render starts `now` is 0, so the rewrite is complete and free. This is exactly the rewrite
    // that must never happen in real time, where already-written cycles are audio that is about
    // to play and re-cutting them is the splice this scheduler exists to avoid.
    if (offlineLen) {
      this.phaseRamp.offset.cancelScheduledValues(now);
      this.cycleAt = now;
    }
    // A stall (hidden tab, suspended context) leaves cycleAt far in the past; there is no point
    // rendering history, and walking it cycle by cycle could be thousands of iterations.
    if (this.cycleAt < now) this.cycleAt = now;
    let guard = offlineLen ? 100_000 : 64; // a pathological rate can't spin this loop forever
    while (this.cycleAt < until && guard-- > 0) {
      const period = 1 / Math.max(0.05, this.rate.hz());
      const start = this.cycleAt;
      let len = period;
      if (this._align && this.grid) {
        // Grid slots sit every `period` from the bar line, offset by SHIFT.
        const r = gateCycleLength(start, this.grid.at + this._shift * period, period, GateFx.PULL_MAX);
        len = r.len;
        this.lastErr = r.err;
      } else {
        this.lastErr = 0;
      }
      // The cycle itself: snap to the closed end of the ramp, then sweep to the open end. The
      // snap is at the same value the previous cycle's ramp ENDED on, so the timeline is
      // continuous — no step, whatever the pull did to the lengths either side of it.
      this.phaseRamp.offset.setValueAtTime(-1, start);
      this.phaseRamp.offset.linearRampToValueAtTime(1, start + len);
      this.phaseAtCycle = this.gridPhaseAt(start);
      this.cycleAt = start + len;
    }
  }

  /** Where a ctx time falls within the bar, 0‥1 (0 = the bar line). Null grid → 0. */
  private gridPhaseAt(t: number): number {
    if (!this.grid || !(this.grid.bar > 0)) return 0;
    const p = ((t - this.grid.at) / this.grid.bar) % 1;
    return p < 0 ? p + 1 : p;
  }

  /**
   * The deck's bar grid, in AUDIO CONTEXT time — `at` = the ctx time of a bar line, `bar` = the
   * bar's length in ctx seconds (track seconds ÷ playback rate). The panel derives both from
   * `deck.beatgrid`, the same source the waveform's bar lines come from, so the gate lands on the
   * lines you can see rather than on a re-derivation of them. Null = no grid (unloaded/unanalysed
   * deck), which falls back to free-running.
   */
  setGrid(ref: { at: number; bar: number; beatsPerBar?: number } | null) {
    this.grid = ref && ref.bar > 0 ? { at: ref.at, bar: ref.bar, beatsPerBar: Math.max(1, Math.round(ref.beatsPerBar ?? 4)) } : null;
    this.tick();
  }

  // Kept for the panels/harness that only know about a rate: a rate change never rewrites what is
  // already scheduled, it just changes the length of the cycles that follow.
  private applyFreq() {
    this.tick();
  }

  // ---- depth / floor -------------------------------------------------------
  private applyDepth() {
    this.depthGain.gain.setTargetAtTime(this._depth, this.ctx.currentTime, 0.01);
    this.floorConst.offset.setTargetAtTime(1 - this._depth, this.ctx.currentTime, 0.01);
  }

  private refreshCurve() {
    this.shaper.curve = makeWindowCurve(this._shape, this._duty, this._smooth);
  }

  // Insert dry crossfade (saturator pattern): dry = (1 − mix) active, 1 when bypassed.
  private applyDry() {
    this.dry.gain.setTargetAtTime(this.isBypassed ? 1 : 1 - this.mixAmount, this.ctx.currentTime, 0.01);
  }
  protected setMix(v: number) {
    super.setMix(v);
    this.applyDry();
  }
  setBypass(on: boolean) {
    super.setBypass(on);
    this.applyDry();
  }

  private setRate(v: number) {
    this.rate.setRate(v);
    this.applyFreq();
  }
  private setDepth(v: number) {
    this._depth = clamp01(v);
    this.applyDepth();
  }
  private setDuty(v: number) {
    this._duty = clamp01(v);
    this.refreshCurve();
  }
  private setSmooth(v: number) {
    this._smooth = clamp01(v);
    this.refreshCurve();
  }
  private setShape(v: number) {
    this._shape = clamp(Math.round(v), 0, GATE_SHAPES.length - 1);
    this.refreshCurve();
  }
  private setSync(on: boolean) {
    this.rate.setSync(on);
    this.applyFreq();
  }
  private setAlign(on: boolean) {
    this._align = on;
    this.tick();
  }
  private setShift(v: number) {
    this._shift = clamp01(v);
    this.tick();
  }

  /** The panel feeds the deck's live `effectiveBpm` so the synced gate tracks tempo changes. */
  setSyncBpm(bpm: number) {
    if (this.rate.setBpm(bpm)) this.applyFreq();
  }

  // Pad-throw TRIGGER: simply ENGAGE the gate (un-bypass if dormant) at the dialed RATE/DEPTH
  // while held; release re-bypasses if it was off. A true trigger — no rate/depth intensify, and
  // no throwMix override needed either: the base class's own default already floors mix at this
  // device's full-wet (1.0) construction default (see BaseFxDevice.throwMix).

  // ---- live reads for the WYSIWYG -----------------------------------------
  get shapeIndex() {
    return this._shape;
  }
  get synced() {
    return this.rate.sync;
  }
  get freqHz() {
    return this.rate.hz();
  }
  get divLabel() {
    return this.rate.divLabel;
  }
  get aligned() {
    return this._align;
  }
  get shift() {
    return this._shift;
  }
  /** True once the gate is actually ON the grid (the pull has converged) — the viz says so. */
  get locked() {
    return this._align && !!this.grid && Math.abs(this.lastErr) < 0.02;
  }
  /** How far off the grid the gate still is, in CYCLES (signed; + = running late). */
  get gridError() {
    return this._align && this.grid ? this.lastErr : 0;
  }
  /** Bar phase (0‥1) at a ctx time — lets the viz draw the deck's bar line on the gate's axis. */
  barPhaseAt(t: number) {
    return this.gridPhaseAt(t);
  }
  /** Cycles per bar / per beat, so the viz can lay the deck's own grid over the gate's axis. */
  get cyclesPerBar() {
    if (!this.grid || !(this.grid.bar > 0)) return 0;
    return this.grid.bar * Math.max(0.05, this.rate.hz());
  }
  get beatsPerBar() {
    return this.grid?.beatsPerBar ?? 4;
  }
  /** The live phase (0‥1) of the cycle sounding right now — the viz playhead. */
  get phaseNow() {
    const period = 1 / Math.max(0.05, this.rate.hz());
    const p = ((this.ctx.currentTime - (this.cycleAt - period)) / period) % 1;
    return p < 0 ? p + 1 : p;
  }
  /** The grid phase the current cycle began on (viz bookkeeping). */
  get cycleGridPhase() {
    return this.phaseAtCycle;
  }
  /** The full gain envelope (what you hear) at phase p∈[0,1): (1−depth) + depth·window. */
  gateShape(p: number): number {
    const d = this._depth;
    return 1 - d + d * windowShape(((p % 1) + 1) % 1, this._shape, this._duty, this._smooth);
  }

  private registerParams() {
    this.params.push(
      { id: "rate", def: 0.2, get: () => this.rate.ext, set: (v) => this.setRate(v) },
      { id: "depth", def: 0.85, get: () => this._depth, set: (v) => this.setDepth(v) },
      { id: "duty", def: 0.5, get: () => this._duty, set: (v) => this.setDuty(v) },
      { id: "smooth", def: 0.15, get: () => this._smooth, set: (v) => this.setSmooth(v) },
      { id: "shape", def: 0, get: () => this._shape, set: (v) => this.setShape(v) },
      { id: "sync", def: 1, get: () => (this.rate.sync ? 1 : 0), set: (v) => this.setSync(v >= 0.5) },
      // ALIGN defaults ON: a trance gate that isn't on the grid is a broken trance gate, and FREE
      // is the deliberate choice (a slow un-synced sweep against the track), not the resting state.
      { id: "align", def: 1, get: () => (this._align ? 1 : 0), set: (v) => this.setAlign(v >= 0.5) },
      { id: "shift", def: 0, get: () => this._shift, set: (v) => this.setShift(v) },
    );
  }

  dispose() {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    try {
      this.phaseRamp.stop();
    } catch {
      /* already stopped */
    }
    try {
      this.floorConst.stop();
    } catch {
      /* already stopped */
    }
    super.dispose();
  }
}
