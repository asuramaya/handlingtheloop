// Pro parametric EQ for a deck channel. A series chain of biquads, each a movable
// node in the curve UI:
//
//   input → HP-cut → low-shelf → mid-bell → high-shelf → LP-cut → output
//
// Shelves/bell carry gain (+ movable frequency, + Q on the bell); the HP/LP cuts
// carry a movable cutoff + resonance (Q). The band identities low/mid/high are kept
// so channel reset and room-sync map 1:1. `input`/`output` are plain gain nodes so
// the whole EQ can be re-routed for two extra modes:
//   • SOLO (audition): feed input straight through a bandpass to output, so you hear
//     just one band's frequency region while you hunt for the problem spot.
//   • BYPASS: feed input straight to output (compare with the EQ out of circuit).

// Band gain range. The cut side reaches a TRUE KILL (−40 dB is gone, not "quiet") because a DJ
// bass swap wants the low band to vanish, not to leave a ghost under the incoming track. The boost
// side reaches +12 so a preset can be a real gesture — the old +6 ceiling made every boost a
// mastering nudge. What makes +12 safe is EQ_OUT_DB: the curve now carries its own output trim,
// so a boost-heavy preset level-matches itself instead of eating the channel's headroom.
export const EQ_MIN_DB = -40;
export const EQ_MAX_DB = 12;
export const EQ_OUT_DB = 12; // output trim travel, ± (0 = unity)

// Movable band frequencies (Hz) + travel range. Defaults match the classic layout.
export const EQ_BANDS = {
  low: { freq: 200, min: 40, max: 500 },
  mid: { freq: 1000, min: 200, max: 6000 },
  high: { freq: 3200, min: 1500, max: 16000 },
} as const;

// Cut filters sit "off" at the spectrum extremes until dragged inward.
export const EQ_HP = { freq: 20, min: 20, max: 2200, q: 0.3 } as const;
export const EQ_LP = { freq: 20000, min: 320, max: 20000, q: 0.3 } as const;
export const EQ_Q_MIN = 0.3;
export const EQ_Q_MAX = 12;

// ★ Web Audio reads Q in DECIBELS for LOWPASS and HIGHPASS (alpha = sin(w0)/(2·10^(Q/20))) — but
// LINEARLY for peaking/notch/bandpass. One `Q` param, two meanings. So the HP/LP cuts were never
// flat: a "Butterworth" 0.7 was really 0.7 dB of resonance (linear Q ≈ 1.08, a +1.7 dB bump right
// at the corner), which is why a supposedly-flat EQ still had a lump at 20 Hz. The bells are fine —
// their Q really is linear.
//
// The knob keeps its 0.3‥12 face (profiles, presets and the drag mapping all speak it), and we map
// it onto the resonance the filter actually wants: EQ_Q_MIN is now genuinely FLAT (−3.01 dB is
// Butterworth: 10^(−3.01/20) = 0.7071), climbing to a strong peak at the top of the travel.
const RES_FLAT_DB = -3.01;
const RES_SPAN_DB = 15; // knob top → +12 dB of resonance (linear Q ≈ 4)
const resDb = (q: number) => RES_FLAT_DB + ((clampQ(q) - EQ_Q_MIN) / (EQ_Q_MAX - EQ_Q_MIN)) * RES_SPAN_DB;

// Per-band SHAPE — each of LOW/MID/HIGH can switch filter character, so the three bands
// carry a consistent control. Web-Audio honours Q only for the "peaking" (bell) type;
// the shelves ignore it, so the UI greys the Q cell out of bell mode. Index order is the
// wire contract (shapes ride the eq*Shape ControlParams as the index).
export const EQ_SHAPE_TYPES = ["peaking", "lowshelf", "highshelf", "notch"] as const;
export const EQ_SHAPE_LABELS = ["BELL", "LO-SH", "HI-SH", "NOTCH"] as const;
export const EQ_SHAPE_DEFAULT = { low: 1, mid: 0, high: 2 } as const; // lo-shelf / bell / hi-shelf

export type EqRoute = "normal" | "solo" | "bypass";

import type { FxDevice } from "./Fx";

export class Eq3 implements FxDevice {
  readonly kind = "eq" as const;
  readonly ctx: AudioContext;
  readonly input: GainNode;
  readonly output: GainNode;
  private readonly pre: GainNode; // routing branch point (input → pre → chain/solo/output)
  private readonly hp: BiquadFilterNode; // low-cut (high-pass)
  private readonly low: BiquadFilterNode;
  private readonly mid: BiquadFilterNode;
  private readonly high: BiquadFilterNode;
  private readonly lp: BiquadFilterNode; // high-cut (low-pass)
  private readonly soloNode: BiquadFilterNode; // audition bandpass
  private readonly dry: GainNode; // parallel dry path for the wet/dry blend
  private readonly wet: GainNode; // EQ-chain output for the wet/dry blend
  private _mix = 1; // wet/dry: 0 = flat/dry, 1 = full EQ (default)
  private _out = 0; // output trim (dB), applied to the WET path only — see setOut
  private route: EqRoute = "normal";
  private lowShapeIdx: number = EQ_SHAPE_DEFAULT.low;
  private midShapeIdx: number = EQ_SHAPE_DEFAULT.mid;
  private highShapeIdx: number = EQ_SHAPE_DEFAULT.high;
  // Scratch buffers for getFrequencyResponse, grown to the query length.
  private mag?: Float32Array<ArrayBuffer>;
  private phase?: Float32Array<ArrayBuffer>;

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.pre = ctx.createGain();
    // input → pre is permanent so external taps on `input` (e.g. the deck's pre-EQ
    // spectrum analyser) survive route changes; only `pre`'s output is re-routed.
    this.input.connect(this.pre);

    this.hp = ctx.createBiquadFilter();
    this.hp.type = "highpass";
    this.low = ctx.createBiquadFilter();
    this.low.type = "lowshelf";
    this.mid = ctx.createBiquadFilter();
    this.mid.type = "peaking";
    this.high = ctx.createBiquadFilter();
    this.high.type = "highshelf";
    this.lp = ctx.createBiquadFilter();
    this.lp.type = "lowpass";
    // Seed every node through the setters, so the commanded mirror (`cmd`) starts populated —
    // a getter must never read `undefined` before the first knob move.
    this.setHpFreq(EQ_HP.freq);
    this.setHpQ(EQ_HP.q);
    this.setLow(0);
    this.setLowFreq(EQ_BANDS.low.freq);
    this.setLowQ(1);
    this.setMid(0);
    this.setMidFreq(EQ_BANDS.mid.freq);
    this.setMidQ(0.9);
    this.setHigh(0);
    this.setHighFreq(EQ_BANDS.high.freq);
    this.setHighQ(1);
    this.setLpFreq(EQ_LP.freq);
    this.setLpQ(EQ_LP.q);

    this.soloNode = ctx.createBiquadFilter();
    this.soloNode.type = "bandpass";
    this.soloNode.Q.value = 4;

    // Wet/dry blend gains (normal route only). Default full-wet so the EQ behaves exactly as
    // before until the knob is dialled back.
    this.dry = ctx.createGain();
    this.wet = ctx.createGain();
    this.dry.gain.value = 0;
    this.wet.gain.value = 1;

    // Build the series EQ chain; applyRoute() wires the ACTIVE path's tail into `output`
    // (and severs the idle paths) so only one route is live — and rendered — at a time.
    this.hp.connect(this.low);
    this.low.connect(this.mid);
    this.mid.connect(this.high);
    this.high.connect(this.lp);
    this.applyRoute();
  }

  // Re-route BOTH ends so only the active path reaches `output`. Severing the idle path's
  // TAIL (not just its head) leaves it with no route to the destination, so the audio
  // thread prunes it: a bypassed EQ doesn't run its five biquads, a non-solo EQ doesn't run
  // the audition bandpass. (The in-series counterpart to BaseFxDevice's activation gate.)
  private applyRoute() {
    this.pre.disconnect();
    for (const n of [this.lp, this.soloNode, this.dry, this.wet]) {
      try {
        n.disconnect();
      } catch {
        /* not wired yet */
      }
    }
    if (this.route === "bypass") {
      this.pre.connect(this.output);
    } else if (this.route === "solo") {
      this.pre.connect(this.soloNode);
      this.soloNode.connect(this.output);
    } else {
      // NORMAL: parallel dry + the EQ chain (wet), blended by _mix. At mix = 1 the dry gain is 0,
      // so this is bit-identical to the old series wiring.
      this.pre.connect(this.hp);
      this.lp.connect(this.wet);
      this.wet.connect(this.output);
      this.pre.connect(this.dry);
      this.dry.connect(this.output);
      this.applyMix();
    }
  }
  private applyMix() {
    this.dry.gain.value = 1 - this._mix;
    this.wet.gain.value = this._mix * Math.pow(10, this._out / 20);
  }
  /** OUTPUT TRIM (dB) — makeup gain for the curve, on the WET path only. A boost-heavy preset
   *  can now pay for itself (pull the trim down) instead of eating the channel's headroom, which
   *  is what lets the band gains reach +12 at all. Dry stays at unity: trimming the EQ must never
   *  move the level of a signal the EQ isn't touching (mix 0 / bypass are both untouched). */
  setOut(db: number) {
    this._out = Math.max(-EQ_OUT_DB, Math.min(EQ_OUT_DB, db));
    if (this.route === "normal") this.applyMix();
  }
  get out() {
    return this._out;
  }

  get routeMode(): EqRoute {
    return this.route;
  }
  private setRoute(r: EqRoute) {
    if (this.route === r) return;
    this.route = r;
    this.applyRoute();
  }
  /** Audition one band: route the channel through a bandpass at `hz` (Q for width). */
  solo(hz: number, q = 4) {
    this.soloNode.frequency.value = hz;
    this.soloNode.Q.value = q;
    this.setRoute("solo");
  }
  clearSolo() {
    if (this.route === "solo") this.setRoute("normal");
  }
  setBypass(on: boolean) {
    this.setRoute(on ? "bypass" : "normal");
  }
  get bypassed() {
    return this.route === "bypass";
  }
  /** Wet/dry blend: 1 = full EQ (default), 0 = flat/dry — dial back the EQ intensity or run it
   *  parallel. Only meaningful on the normal route (bypass is already all-dry). */
  setMix(m: number) {
    this._mix = Math.max(0, Math.min(1, m));
    if (this.route === "normal") this.applyMix();
  }
  get mix() {
    return this._mix;
  }

  // --- curve morph -------------------------------------------------------------
  // Stepping a biquad's coefficients while audio flows through it jumps the transfer function
  // against the filter's retained state → a click. A knob ride is continuous, so `.value =` is
  // right there (and stays the default). A PAD THROW slams a whole curve in one frame, so the
  // throw path RAMPS every param over a few ms instead. setTargetAtTime is exponential and never
  // exactly arrives, so we pin the exact value at 5τ — otherwise every throw/restore cycle would
  // land a fraction of a percent short and the numbers would rot over a set.
  private tau = 0; // >0 = ramp writes over this time constant (set only inside applyCurve)
  // COMMANDED values, by param id. Every read (getters, snapshotParams, the mixer knobs) comes
  // from here rather than from `AudioParam.value` — mid-ramp a param reads back somewhere between
  // the old and new curve, and a snapshot taken there would bake the in-between into a preset.
  private readonly cmd: Record<string, number> = {};
  // `audio` lets a param STORE one number and WRITE another — the cut resonance keeps its 0.3‥12
  // knob face in `cmd` (what presets and profiles carry) while the filter gets the dB it actually
  // reads. Everything else stores what it writes.
  private write(p: AudioParam, id: string, v: number, audio = v) {
    this.cmd[id] = v;
    if (this.tau <= 0) {
      p.value = audio;
      return;
    }
    const t = this.ctx.currentTime;
    p.cancelScheduledValues(t);
    p.setTargetAtTime(audio, t, this.tau);
    p.setValueAtTime(audio, t + this.tau * 5);
  }
  /** Apply a whole param map as a smooth MORPH — the FX-pad curve throw (and its restore).
   *  Band SHAPES still switch instantly (a biquad type has no in-between), so a preset that
   *  also flips a shape reads as a harder edge. `mix` is skipped: wet/dry is a live control
   *  that a preset never owns. */
  applyCurve(params: Record<string, number>, seconds = 0.012) {
    this.tau = seconds > 0 ? Math.max(0.002, seconds) / 5 : 0; // 0 = write it instantly (reset / load)
    try {
      for (const id in params) if (id !== "mix") this.setParam(id, params[id]);
    } finally {
      this.tau = 0;
    }
  }

  // --- band gains (dB) ---
  setLow(db: number) {
    this.write(this.low.gain, "low", clampDb(db));
  }
  setMid(db: number) {
    this.write(this.mid.gain, "mid", clampDb(db));
  }
  setHigh(db: number) {
    this.write(this.high.gain, "high", clampDb(db));
  }
  get lowDb() {
    return this.cmd.low;
  }
  get midDb() {
    return this.cmd.mid;
  }
  get highDb() {
    return this.cmd.high;
  }

  // --- band frequencies (Hz) ---
  setLowFreq(hz: number) {
    this.write(this.low.frequency, "lowFreq", clampHz(hz, EQ_BANDS.low));
  }
  setMidFreq(hz: number) {
    this.write(this.mid.frequency, "midFreq", clampHz(hz, EQ_BANDS.mid));
  }
  setHighFreq(hz: number) {
    this.write(this.high.frequency, "highFreq", clampHz(hz, EQ_BANDS.high));
  }
  get lowFreq() {
    return this.cmd.lowFreq;
  }
  get midFreq() {
    return this.cmd.midFreq;
  }
  get highFreq() {
    return this.cmd.highFreq;
  }

  // --- mid bell width ---
  setMidQ(q: number) {
    this.write(this.mid.Q, "midQ", clampQ(q));
  }
  get midQ() {
    return this.cmd.midQ;
  }

  // --- per-band SHAPE (bell / low-shelf / high-shelf) + the now-meaningful shelf Q.
  // Switching a shelf to a bell makes its Q live (peaking biquads honour Q; shelves
  // don't), so LOW/HIGH gain a real width control to match MID. ---
  setLowShape(i: number) {
    this.lowShapeIdx = clampShape(i);
    this.low.type = EQ_SHAPE_TYPES[this.lowShapeIdx];
  }
  get lowShape() {
    return this.lowShapeIdx;
  }
  setMidShape(i: number) {
    this.midShapeIdx = clampShape(i);
    this.mid.type = EQ_SHAPE_TYPES[this.midShapeIdx];
  }
  get midShape() {
    return this.midShapeIdx;
  }
  setHighShape(i: number) {
    this.highShapeIdx = clampShape(i);
    this.high.type = EQ_SHAPE_TYPES[this.highShapeIdx];
  }
  get highShape() {
    return this.highShapeIdx;
  }
  setLowQ(q: number) {
    this.write(this.low.Q, "lowQ", clampQ(q));
  }
  get lowQ() {
    return this.cmd.lowQ;
  }
  setHighQ(q: number) {
    this.write(this.high.Q, "highQ", clampQ(q));
  }
  get highQ() {
    return this.cmd.highQ;
  }

  // --- HP / LP cut filters (cutoff + resonance) ---
  setHpFreq(hz: number) {
    this.write(this.hp.frequency, "hpFreq", clampHz(hz, EQ_HP));
  }
  setHpQ(q: number) {
    this.write(this.hp.Q, "hpQ", clampQ(q), resDb(q)); // knob 0.3‥12 → dB of resonance (0.3 = flat)
  }
  get hpFreq() {
    return this.cmd.hpFreq;
  }
  get hpQ() {
    return this.cmd.hpQ;
  }
  setLpFreq(hz: number) {
    this.write(this.lp.frequency, "lpFreq", clampHz(hz, EQ_LP));
  }
  setLpQ(q: number) {
    this.write(this.lp.Q, "lpQ", clampQ(q), resDb(q));
  }
  get lpFreq() {
    return this.cmd.lpFreq;
  }
  get lpQ() {
    return this.cmd.lpQ;
  }

  /** Flat: all gains 0, every node back to default freq/Q, cuts parked off-screen. */
  reset() {
    this.applyCurve(Eq3.defaults(), 0); // through the setters → the commanded mirror stays true
    this.setMix(1);
    this.setBypass(false);
  }

  /** The flat curve — the device's own defaults as a param map (the preset menu's "Default",
   *  and what the FX pad throws when nothing else is armed). */
  static defaults(): Record<string, number> {
    return {
      low: 0,
      mid: 0,
      high: 0,
      lowFreq: EQ_BANDS.low.freq,
      midFreq: EQ_BANDS.mid.freq,
      highFreq: EQ_BANDS.high.freq,
      midQ: 0.9,
      lowQ: 1,
      highQ: 1,
      hpFreq: EQ_HP.freq,
      hpQ: EQ_HP.q,
      lpFreq: EQ_LP.freq,
      lpQ: EQ_LP.q,
      lowShape: EQ_SHAPE_DEFAULT.low,
      midShape: EQ_SHAPE_DEFAULT.mid,
      highShape: EQ_SHAPE_DEFAULT.high,
      out: 0,
    };
  }

  /** Combined magnitude (dB) at each frequency in `freqHz`, into `outDb` — the real
   *  response of all five biquads, summed in the dB domain. */
  magnitude(freqHz: Float32Array, outDb: Float32Array) {
    const n = freqHz.length;
    if (!this.mag || this.mag.length !== n) {
      this.mag = new Float32Array(n);
      this.phase = new Float32Array(n);
    }
    outDb.fill(this._out); // the output trim shifts the whole curve — draw it where it really sits
    const f = freqHz as Float32Array<ArrayBuffer>;
    for (const band of [this.hp, this.low, this.mid, this.high, this.lp]) {
      band.getFrequencyResponse(f, this.mag, this.phase!);
      for (let i = 0; i < n; i++) outDb[i] += 20 * Math.log10(this.mag[i] || 1e-6);
    }
    // Scale the drawn curve toward flat by the wet/dry mix — the audible blend is complex
    // (phase-dependent), but interpolating the dB curve to 0 reads right and makes the knob visible.
    if (this._mix !== 1) for (let i = 0; i < n; i++) outDb[i] *= this._mix;
  }

  // --- FxDevice generic param bus ---------------------------------------------
  // String-addressed view over the typed setters/getters above, so session-sync,
  // automix, and MIDI can drive any device (EQ included) uniformly. Unknown ids are
  // ignored — forward-compatible across versions.
  private static readonly PARAMS: ReadonlyArray<{
    id: string;
    get: (e: Eq3) => number;
    set: (e: Eq3, v: number) => void;
  }> = [
    { id: "low", get: (e) => e.lowDb, set: (e, v) => e.setLow(v) },
    { id: "mid", get: (e) => e.midDb, set: (e, v) => e.setMid(v) },
    { id: "high", get: (e) => e.highDb, set: (e, v) => e.setHigh(v) },
    { id: "lowFreq", get: (e) => e.lowFreq, set: (e, v) => e.setLowFreq(v) },
    { id: "midFreq", get: (e) => e.midFreq, set: (e, v) => e.setMidFreq(v) },
    { id: "highFreq", get: (e) => e.highFreq, set: (e, v) => e.setHighFreq(v) },
    { id: "midQ", get: (e) => e.midQ, set: (e, v) => e.setMidQ(v) },
    { id: "hpFreq", get: (e) => e.hpFreq, set: (e, v) => e.setHpFreq(v) },
    { id: "hpQ", get: (e) => e.hpQ, set: (e, v) => e.setHpQ(v) },
    { id: "lpFreq", get: (e) => e.lpFreq, set: (e, v) => e.setLpFreq(v) },
    { id: "lpQ", get: (e) => e.lpQ, set: (e, v) => e.setLpQ(v) },
    { id: "lowShape", get: (e) => e.lowShape, set: (e, v) => e.setLowShape(v) },
    { id: "midShape", get: (e) => e.midShape, set: (e, v) => e.setMidShape(v) },
    { id: "highShape", get: (e) => e.highShape, set: (e, v) => e.setHighShape(v) },
    { id: "lowQ", get: (e) => e.lowQ, set: (e, v) => e.setLowQ(v) },
    { id: "highQ", get: (e) => e.highQ, set: (e, v) => e.setHighQ(v) },
    { id: "out", get: (e) => e.out, set: (e, v) => e.setOut(v) },
  ];

  setParam(id: string, value: number) {
    // "mix" (wet/dry) isn't a curve node so it's not in PARAMS/snapshotParams, but expose it on the
    // GENERIC bus so the FLX BEAT-FX wet/dry knob (deck.setFxParam(slot,"mix",…)) drives the EQ like
    // every other device — otherwise it silently no-ops when the EQ tab is selected.
    if (id === "mix") return void this.setMix(value);
    Eq3.PARAMS.find((p) => p.id === id)?.set(this, value);
  }
  getParam(id: string): number {
    if (id === "mix") return this._mix;
    return Eq3.PARAMS.find((p) => p.id === id)?.get(this) ?? 0;
  }
  snapshotParams(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const p of Eq3.PARAMS) out[p.id] = p.get(this);
    return out;
  }
  paramDefault(id: string): number {
    if (id === "mix") return 1; // fully wet — the EQ is an in-series device, not a send
    return Eq3.defaults()[id] ?? 0;
  }
}

function clampDb(db: number): number {
  return Math.max(EQ_MIN_DB, Math.min(EQ_MAX_DB, db));
}
function clampHz(hz: number, band: { min: number; max: number }): number {
  return Math.max(band.min, Math.min(band.max, hz));
}
function clampQ(q: number): number {
  return Math.max(EQ_Q_MIN, Math.min(EQ_Q_MAX, q));
}
function clampShape(i: number): number {
  return Math.max(0, Math.min(EQ_SHAPE_TYPES.length - 1, Math.round(i)));
}
