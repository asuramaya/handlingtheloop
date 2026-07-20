// Shared DSP primitives for the FX devices. The rack already shares an INTEGRATION spine
// (BaseFxDevice: wet/dry, activation gate, param bus, throw trigger — see Fx.ts); this is the
// UTILITY layer the devices were each hand-rolling: log-frequency mapping, tempo-sync division
// tables, and the sync-vs-free LFO rate. Bespoke per-device DSP cores (the worklets, each
// device's curves/voicing) stay in their own files — only the genuinely common helpers live here.
import { clamp, clamp01 } from "../../util/math";

export { clamp, clamp01 };

// 0..1 knob → an exponential sweep between `min` and `max` (Hz, gain, anything log-perceived).
// Replaces the copy-pasted `min * Math.pow(max/min, ext)` one-liners across the devices.
export const logMap = (min: number, max: number) => (ext: number) => min * Math.pow(max / min, clamp01(ext));

// The Q ENGINE — extracted from Eq3.ts's own resDb/EqCurve.tsx's own qNorm, which solved this
// once for EQ's HP/LP cuts; shared now so any device's resonant cut filter (Delay/Reverb's own
// HP/LP) gets the SAME correctly-flat-at-the-bottom mapping instead of re-deriving it.
//
// ★ Web Audio reads Q in DECIBELS for LOWPASS/HIGHPASS specifically (alpha = sin(w0)/(2·10^(Q/20)))
// — every OTHER filter type (peaking/notch/bandpass/allpass) reads Q LINEARLY. One `.Q` property,
// two meanings depending on `.type`. A resonance knob wants to feel linear-ish (0=flat, climbing to
// a strong peak) regardless of which meaning the filter underneath actually uses, so qToResDb maps
// a knob's qMin..qMax FACE onto the dB value a LOWPASS/HIGHPASS filter actually wants: `flatDb`
// (genuinely flat — −3.01dB is Butterworth) climbing to `flatDb+spanDb` at the top of the knob's
// travel. qToFrac/fracToQ are the SEPARATE concern of putting that same qMin..qMax knob on screen
// (a log-mapped vertical drag axis) — they don't have to share qToResDb's curve shape, only the
// same underlying qMin..qMax range.
export function qToResDb(q: number, qMin: number, qMax: number, flatDb: number, spanDb: number): number {
  return flatDb + ((clamp(q, qMin, qMax) - qMin) / (qMax - qMin)) * spanDb;
}
// The Butterworth-flat Q-in-dB every LOWPASS/HIGHPASS in this rack that wants to be genuinely flat
// uses (10^(−3.01/20) = 0.7071) — was re-derived as the same literal `-3.01` in four separate
// files; one shared constant now. RES_SPAN_DB is the same "knob top → +12dB of resonance" travel
// EQ's own HP/LP already use, reused as the default for any NEW resonant cut (Delay/Reverb).
export const FLAT_RES_DB = -3.01;
export const RES_SPAN_DB = 15;
export function qToFrac(q: number, qMin: number, qMax: number): number {
  return Math.log(clamp(q, qMin, qMax) / qMin) / Math.log(qMax / qMin);
}
export function fracToQ(frac: number, qMin: number, qMax: number): number {
  return qMin * Math.pow(qMax / qMin, clamp01(frac));
}

// Disconnect a node that might already be disconnected (or never connected) — AudioNode.disconnect()
// throws InvalidAccessError otherwise. Any device that tears down and rebuilds part of its own graph
// on a mode change (ModFx's engine swap, SaturatorFx's per-band native/worklet swap) needs this.
export function safeDisconnect(n: AudioNode) {
  try {
    n.disconnect();
  } catch {
    /* already gone */
  }
}

// One tempo-sync division = how many beats span ONE cycle of the effect (1/4 = 1 beat, 1 bar =
// 4 beats, an 1/8 = ½ a beat). Devices pick a slice of this scale suited to their rate range.
export interface Division {
  label: string;
  beats: number;
}

// Common division menus. GATE chops fast (1/4‥1/32); MOD sweeps slow (4 bar‥1/8). Exported so a
// device references the shared table instead of re-declaring its own.
export const GATE_DIVS: Division[] = [
  { label: "1/4", beats: 1 },
  { label: "1/8", beats: 0.5 },
  { label: "1/8T", beats: 1 / 3 },
  { label: "1/16", beats: 0.25 },
  { label: "1/16T", beats: 1 / 6 },
  { label: "1/32", beats: 0.125 },
];
export const MOD_DIVS: Division[] = [
  { label: "4 bar", beats: 16 },
  { label: "2 bar", beats: 8 },
  { label: "1 bar", beats: 4 },
  { label: "1/2", beats: 2 },
  { label: "1/4", beats: 1 },
  { label: "1/8", beats: 0.5 },
];

// A rate that is EITHER a free knob (Hz) OR locked to a musical division of the deck tempo. One
// 0..1 `ext` drives both: free → `freeHz(ext)`; synced → the division it indexes at the live BPM.
// A pure value-holder (no audio nodes) — the owning device reads `hz()` and applies it to its
// own oscillator, so SYNC/free behaves identically everywhere (GATE, MOD, …). `setBpm` returns
// whether the *sounding* rate changed, so the device only re-applies when synced + actually moved.
export class SyncRate {
  private _ext: number;
  private _sync = false;
  private _bpm = 120;

  constructor(
    private readonly divs: Division[],
    private readonly freeHz: (ext: number) => number,
    private readonly lo: number, // clamp on the synced Hz (free is the caller's own range)
    private readonly hi: number,
    ext = 0.3,
  ) {
    this._ext = clamp01(ext);
  }

  setRate(ext: number) {
    this._ext = clamp01(ext);
  }
  setSync(on: boolean) {
    this._sync = on;
  }
  /** Feed the deck's live BPM. Returns true when a SYNCED rate actually shifted (re-apply then). */
  setBpm(bpm: number): boolean {
    if (!(bpm > 0) || Math.abs(bpm - this._bpm) < 0.01) return false;
    this._bpm = bpm;
    return this._sync;
  }
  get sync() {
    return this._sync;
  }
  get ext() {
    return this._ext;
  }
  private divIndex() {
    return clamp(Math.round(this._ext * (this.divs.length - 1)), 0, this.divs.length - 1);
  }
  get divLabel() {
    return this.divs[this.divIndex()].label;
  }
  /** The live frequency: a clamped division of the tempo when synced, else the free knob. */
  hz(): number {
    if (this._sync) return clamp(this._bpm / 60 / this.divs[this.divIndex()].beats, this.lo, this.hi);
    return this.freeHz(this._ext);
  }
}
