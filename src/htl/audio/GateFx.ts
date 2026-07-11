// Trance GATE — a tempo-synced rhythmic amplitude gate (the Gross Beat / trance-gate /
// stutter family). NATIVE Web Audio (no worklet): a sawtooth `OscillatorNode` is the PHASE
// RAMP, a `WaveShaperNode` maps that phase to the gate WINDOW (shape + duty + smooth), and the
// window — scaled by DEPTH and lifted by a (1−depth) floor — drives the gain of a single
// insert `GainNode`. So the audio is ducked rhythmically, locked to the deck's beat.
//
//   input ─────────────────────→ gate ──────────────→ wet ─(mix)→ output
//                                  ▲.gain = (1−depth) + depth·window(phase)
//   sawLfo(phase) → shaper(window 0..1) → depthGain(×depth) ─┘
//   floorConst(1−depth) ─────────────────────────────────────┘
//
// A real INSERT (dry/wet crossfade like the saturator), free when bypassed via the wet gate.
// The window curve regenerates only on shape/duty/smooth change; rate/depth are live AudioParam
// ramps. RATE is a musical division synced to `effectiveBpm` (the panel feeds it each frame),
// or a free Hz rate when SYNC is off.
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

function makeWindowCurve(shape: number, duty: number, smooth: number) {
  const c = new Float32Array(CURVE_LEN);
  for (let i = 0; i < CURVE_LEN; i++) c[i] = clamp01(windowShape(i / (CURVE_LEN - 1), shape, duty, smooth));
  return c;
}

export class GateFx extends BaseFxDevice {
  readonly kind: FxKind = "gate";

  private readonly gate: GainNode; // the insert VCA — its .gain is the gate envelope
  private readonly sawLfo: OscillatorNode; // -1..1 ramp = the phase source
  private readonly shaper: WaveShaperNode; // phase → window (0..1)
  private readonly depthGain: GainNode; // window × depth
  private readonly floorConst: ConstantSourceNode; // (1 − depth) floor

  // RATE = a tempo-synced division (default) or a free 0.2‥20 Hz knob; synced Hz clamped 0.05‥80.
  private readonly rate = new SyncRate(GATE_DIVS, gateFreeHz, 0.05, 80, 0.2);
  private _depth = 0.85;
  private _duty = 0.5;
  private _smooth = 0.15;
  private _shape = 0;
  private _throw = false;

  constructor(ctx: AudioContext) {
    super(ctx, 1.0); // insert: full wet by default
    this.gate = ctx.createGain();
    this.gate.gain.value = 0; // intrinsic 0 — the floor + depthGain SUM into it
    this.shaper = ctx.createWaveShaper();
    this.depthGain = ctx.createGain();
    this.floorConst = ctx.createConstantSource();
    this.sawLfo = ctx.createOscillator();
    this.sawLfo.type = "sawtooth";
    this.rate.setSync(true); // GATE defaults to beat-synced

    // window envelope → gate.gain
    this.sawLfo.connect(this.shaper).connect(this.depthGain).connect(this.gate.gain);
    this.floorConst.connect(this.gate.gain);
    // audio insert: input → gate → wet
    this.input.connect(this.gate).connect(this.wet);

    this.refreshCurve();
    this.applyDepth();
    this.applyFreq();
    this.applyDry();
    this.floorConst.start();
    this.sawLfo.start();
    this.registerParams();
  }

  // ---- frequency -----------------------------------------------------------
  private applyFreq() {
    this.sawLfo.frequency.setTargetAtTime(this.rate.hz(), this.ctx.currentTime, 0.01);
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

  /** The panel feeds the deck's live `effectiveBpm` so the synced gate tracks tempo changes. */
  setSyncBpm(bpm: number) {
    if (this.rate.setBpm(bpm)) this.applyFreq();
  }

  /** Pad-throw TRIGGER: simply ENGAGE the gate (un-bypass if dormant) at the dialed RATE/DEPTH
   *  while held; release re-bypasses if it was off. A true trigger — no rate/depth intensify. */
  protected applyThrowBoost(on: boolean) {
    this._throw = on;
  }
  get throwing() {
    return this._throw;
  }

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
    );
  }

  dispose() {
    try {
      this.sawLfo.stop();
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
