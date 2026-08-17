// Modulation (MOD) — chorus / flanger / phaser / barber, the MetaFlanger × Arturia model (+ one
// invented mode). One shared MOD WRAPPER (an LFO + an envelope follower, blended) feeds a
// SWAPPABLE inner engine picked by MODE: chorus & flanger are N modulated delay-line VOICES (a
// cubic worklet each, every voice running its OWN LFO phase); a phaser is a real ALLPASS cascade
// (non-uniform notches — not a comb fake). BARBER doesn't use the shared wrapper at all — it's
// pairs of sawtooth-driven comb lines (see buildEngine's BARBER branch) producing the "infinite
// sweep" illusion: a notch that only ever climbs or falls, never resets. Send-style (dry + wet
// sum is what creates the comb/notch cancellation), padded so the sum can't exceed the dry.
//
//   input ─┬─→ dry (×pad) ───────────────────────────────────────────────→ output
//          ├─→ engineIn → [voices | allpass cascade | N× saw comb pairs] → engineOut → tone → wetPad → wet → output
//          └─→ rect→lp→envGain ─┬─→ envTap ──→ (worklet voices' env input, BARBER depth tap)
//                                └─→ modBus ←─ lfo→lfoGain     → (phaser detune, native fallback delayTime, modTap for the viz)
//
// ★ REBUILDS CROSSFADE, THEY DON'T SPLICE. Every mode/STAGES/WAVE/THRU change builds a fresh
// engine behind its own `engineOut` gain (ramped up from 0) while the previous engine's engineOut
// ramps to 0 and its nodes are torn down only once the audio clock is past that fade — an instant
// disconnect of a live wet chain is a hard splice, and STAGES fires one on every integer step.
import { BaseFxDevice, type FxKind } from "./Fx";
import { logMap, SyncRate, MOD_DIVS, safeDisconnect } from "./fxDsp";

export const MOD_MODES = ["CHORUS", "FLANGER", "PHASER", "BARBER"] as const;
export const MOD_WAVES = ["SINE", "TRI", "SQUARE"] as const;
export const MOD_SOURCES = ["LFO", "ENV", "BOTH"] as const;
/** BARBER's WAVE slots reshape its RAMP, not an LFO — the same three indices, their own names. */
export const BARBER_RAMPS = ["EASE", "LINEAR", "SNAP"] as const;
/** The LFO shape (−1..1) at phase p (0..1) for a WAVE index — the same shapes the worklet voices
 *  run, so a viz can place voice k at p + k/N on the exact curve the engine uses. */
export function modLfoShape(wave: number, p: number): number {
  p -= Math.floor(p);
  if (wave === 1) return p < 0.5 ? 4 * p - 1 : 3 - 4 * p;
  if (wave === 2) return p < 0.5 ? 1 : -1;
  return Math.sin(2 * Math.PI * p);
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const modFreeHz = logMap(0.05, 10); // free-mode LFO RATE: 0.05‥10 Hz
const oscType = (w: number): OscillatorType => (w === 1 ? "triangle" : w === 2 ? "square" : "sine");

function absCurve() {
  const n = 1024;
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) c[i] = Math.abs((i / (n - 1)) * 2 - 1); // full-wave rectifier
  return c;
}

const BARBER_BASE = 0.0002; // 0.2 ms — first comb null ~2.5 kHz at zero depth
const BARBER_MAG = 0.02; // 20 ms sweep range at full depth — first null down to ~25 Hz
const PHASER_SWEEP_CENTS = 1200; // ±1 octave at full depth, via detune — see buildEngine's PHASER branch
const THRU_DRY_OFFSET = 0.0028; // s — FLANGER's nominal base; the dry's offset under THRU (see applyThruDelay)
const PHASER_LOOP_MAX = 0.82; // the cascade's feedback ceiling, throw included — see applyThrowBoost
const CHORUS_WET_HP_HZ = 120; // CHORUS keeps its bass dry (below this the phase-spread voices are
// still mutually coherent — spacing ≪ wavelength — and would sum to a √N bass pump twice per LFO
// cycle; it's also just what a chorus should do to a bassline: leave it alone).
const REBUILD_FADE = 0.012; // s — engineOut crossfade time constant on a rebuild
const REBUILD_HOLD = 0.08; // s — how far past the fade the audio clock must be before teardown

// ---- BARBER's shaping curves ---------------------------------------------------------------
// All of these are WaveShaper curves indexed by the sawtooth's VALUE x∈[-1,1] (φ=(x+1)/2 is its
// phase). ★ THE RAMP AND THE ENVELOPE ARE BOTH FROZEN FOR |x| > 1−RAMP_GUARD. The oscillator is a
// band-limited sawtooth (a PeriodicWave — see barberSaw), so it doesn't jump cleanly at the
// wrap: it rings (Gibbs, ~9% of the 2-unit jump ≈ 1.8 ms of delay excursion in a handful of
// samples) on BOTH sides. So the ramp SATURATES before the ringing zone (the delay simply holds),
// and the envelope — driven by a triangle, see ENVELOPE_CURVE — is zero across the whole transit.
const RAMP_GUARD = 0.2; // |x| ≥ 0.8 → held
function rampCurve(shape: (u: number) => number) {
  const n = 257;
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const u = clamp01((x / (1 - RAMP_GUARD) + 1) / 2); // -0.8..0.8 → 0..1, held outside
    c[i] = clamp01(shape(u));
  }
  return c;
}
// WAVE, for BARBER, reshapes the RAMP itself — a separate branch of the graph from the crossfade
// envelope below (both fork from the same raw sawtooth, neither feeds the other), so swapping this
// curve can't touch the click-free math at all. EASE = raised-cosine (lingers at the ends, rushes
// the middle). LINEAR = the plain ramp. SNAP (the SQUARE slot) = a fast smoothstep sweep through
// the middle 40% of the cycle with long holds either side — the "robotic" character the old 8-rung
// STAIRCASE was after, without its 8 hard delay JUMPS per cycle (each of those was a splice; a
// stepped delay time is a click by definition, no envelope can hide a jump mid-cycle).
const BARBER_RAMP_SHAPES: ((u: number) => number)[] = [
  (u) => (1 - Math.cos(Math.PI * u)) / 2,
  (u) => u,
  (u) => {
    const t = clamp01((u - 0.3) / 0.4);
    return t * t * (3 - 2 * t);
  },
];
const BARBER_RAMP_CURVES = BARBER_RAMP_SHAPES.map(rampCurve);
/** BARBER's ramp position (0..1) for a WAVE index at ramp phase u (0..1) — the shape the engine's
 *  WaveShaper runs (before the ±RAMP_GUARD hold), for a viz drawing the sweep. */
export function barberRampShape(wave: number, u: number): number {
  return clamp01((BARBER_RAMP_SHAPES[wave] ?? BARBER_RAMP_SHAPES[1])(clamp01(u)));
}
// BARBER's crossfade envelope. ★ INDEXED BY A TRIANGLE, NOT BY THE SAWTOOTH. The obvious design —
// shape the envelope from the same saw that drives the ramp, zero for a margin around |x|=1 —
// has a hole in it that fxlab's --mod-spikes made visible: a band-limited saw doesn't JUMP at the
// wrap, it SLEWS through every value in between (256 partials → the +1→−1 transit takes ~1/256 of
// a cycle, 2‥3 ms at LFO rates), so a value-indexed envelope passes straight through its e=1
// region at x≈0 IN THE MIDDLE OF THE WRAP — a full-gain glitch while the delay scrubs its whole
// range in a couple of ms: a click per wrap per line, by construction (Chrome's built-in saw
// slewed faster, so it was a SHORTER click, −45 dB; never a clean one). A triangle at the same
// phase has no wrap at all, and its MINIMUM lands in TIME exactly on the saw's wrap — so the
// envelope is zero across the whole transit (and the ramp's ringing either side) whatever the
// saw's value does. e(v) = ½ + ½·clamp(v/(1−m)): flat 0 for a margin around the minimum, flat 1
// around the maximum, linear between; line B's triangle is line A's negated (a half-cycle shift
// of an odd-harmonic wave), and e(v)+e(−v) ≡ 1 exactly — an algebraic identity, so the pair's
// crossfade is unity everywhere.
const BARBER_MARGIN = 0.15; // of the triangle's ±1 range — the flat-zero/flat-one bands each side
function barberEnvelopeCurve(margin: number) {
  const n = 257;
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const v = (i / (n - 1)) * 2 - 1;
    c[i] = 0.5 + 0.5 * Math.max(-1, Math.min(1, v / (1 - margin)));
  }
  return c;
}
const ENVELOPE_CURVE = barberEnvelopeCurve(BARBER_MARGIN);
// Oscillator waves with their PHASE baked in — Web Audio can't start an oscillator at a phase,
// and the old design worked around that by delaying start() up to a full period per line, during
// which a not-yet-started line's silence read as envelope=1 (a full-open static tap: the pair
// summed to 2 for up to 20 s at the slowest rate). Baking phase θ (cycles) into a PeriodicWave
// lets every line start NOW, exactly where it should be. For a wave Σ A_k·f(kωt), f(k(ωt+2πθ))
// expands into cos/sin(kωt) terms — real_k/imag_k below. The saw drives the RAMP (256 partials:
// ringing width ~1/256 cycle, inside RAMP_GUARD); the triangle drives the ENVELOPE, its minimum
// locked to the same phase.
const BARBER_PARTIALS = 256;
function barberSaw(ctx: BaseAudioContext, theta: number): PeriodicWave {
  // saw(t+θ) = (2/π)Σ (−1)^{k+1}/k · sin(k(ωt+2πθ)) — rises through 0 at phase θ, wraps at θ+½
  const real = new Float32Array(BARBER_PARTIALS + 1);
  const imag = new Float32Array(BARBER_PARTIALS + 1);
  for (let k = 1; k <= BARBER_PARTIALS; k++) {
    const a = ((2 / Math.PI) * (k % 2 === 1 ? 1 : -1)) / k;
    real[k] = a * Math.sin(2 * Math.PI * k * theta);
    imag[k] = a * Math.cos(2 * Math.PI * k * theta);
  }
  return ctx.createPeriodicWave(real, imag, { disableNormalization: true });
}
function barberTri(ctx: BaseAudioContext, theta: number): PeriodicWave {
  // tri(t+θ) = (8/π²)Σ_{k odd} 1/k² · cos(k(ωt+2πθ)) — +1 at phase θ, −1 at θ+½ (the saw's wrap)
  const real = new Float32Array(BARBER_PARTIALS + 1);
  const imag = new Float32Array(BARBER_PARTIALS + 1);
  for (let k = 1; k <= BARBER_PARTIALS; k += 2) {
    const a = 8 / (Math.PI * Math.PI * k * k);
    real[k] = a * Math.cos(2 * Math.PI * k * theta);
    imag[k] = -a * Math.sin(2 * Math.PI * k * theta);
  }
  return ctx.createPeriodicWave(real, imag, { disableNormalization: true });
}

// One built engine — everything buildEngine() created for the current mode, kept together so a
// rebuild can retire it as a unit (fade its engineOut, then tear it down once the clock is past).
interface Engine {
  nodes: AudioNode[];
  scales: { g: GainNode; mag: number }[]; // depth-modulation scales (phaser detune / native fallback)
  fbGain: GainNode | null; // PHASER only: the cascade's SINGLE feedback loop
  fbGains: { g: GainNode; mult: number }[]; // native-fallback voices + BARBER: per-voice feedback
  delayNodes: AudioWorkletNode[]; // CHORUS/FLANGER: one cubic-delay worklet per voice
  oscs: OscillatorNode[]; // BARBER's own sawtooth ramps — need stop(), not just disconnect
  links: { undo: () => void; viz: boolean }[]; // undo for every PERMANENT-node → this-engine
  // connection (modBus/envTap/modTap); `viz` ones are undone the instant the engine retires
  feed: GainNode; // engineIn → feed → engine — THIS engine's own entry point AND its feedback
  // re-entry (never the shared engineIn: while a retiring engine overlaps the new one, two loops
  // summing into one shared node would ADD their loop gains — 0.8 + 0.8 runs away to Inf inside
  // the fade window, poisons every biquad downstream, and Chrome logs "BiquadFilterNode: state is
  // bad". Caught by fxlab's --mod-audit the first time the crossfade ran.) Retiring mutes it, so
  // the old loop decays instead of ringing on behind a closed engineOut.
  engineOut: GainNode; // engine → engineOut → tone; the crossfade handle
  retiredAt: number; // ctx time the fade-out began (0 = live)
}

export class ModFx extends BaseFxDevice {
  readonly kind: FxKind = "mod";

  // shared mod sources (built once)
  private readonly lfo: OscillatorNode;
  private readonly lfoGain: GainNode;
  private readonly envLp: BiquadFilterNode;
  private readonly envGain: GainNode;
  private readonly envTap: GainNode; // envelope-only feed (worklet voices' input 1, BARBER's depth tap)
  private readonly modBus: GainNode; // LFO + envelope (phaser detune, native fallback, the viz)
  private readonly modTap: GainNode; // ★ a STABLE node the viz can tap once — re-fed on every rebuild
  private readonly phaseTap: GainNode; // ★ the live LFO PHASE (0..1) of the tapped voice, when the
  // engine can report one (the worklet voices do — output 2); silent otherwise
  private readonly lfoTap: GainNode; // ★ the native LFO ALONE (±1, SOURCE-gated) — for PHASER's viz to
  // recover phase from, uncontaminated by the envelope share that modSignal carries in ENV/BOTH
  private readonly engineIn: GainNode; // wet feed → every engine's own `feed`
  private readonly tone: BiquadFilterNode; // post HP/LP on the wet
  private readonly wetPad: GainNode; // tone → wetPad → wet: the mix-law pad (see applyMixLaw)
  private readonly dryDelay: DelayNode; // input → dryDelay → dry: 0 except FLANGER+THRU (see applyThruDelay)

  private engine: Engine | null = null;
  private retired: Engine[] = [];
  private retireTimer: number | null = null;
  private stagesRebuildTimer: number | null = null; // see setStages() — debounces the rebuild

  private _mode = 0;
  private readonly rate = new SyncRate(MOD_DIVS, modFreeHz, 0.01, 40, 0.3);
  private _depth = 0.5;
  private _fb = 0.3;
  private _tone = 0.5;
  private _stages = 6;
  private _wave = 0;
  private _src = 0;
  private _thru = false;

  constructor(ctx: AudioContext) {
    super(ctx, 0.5); // send-style, half wet (equal dry/wet = deepest notches)
    this.lfo = ctx.createOscillator();
    this.lfo.type = "sine";
    this.lfo.frequency.value = this.rate.hz();
    this.lfoGain = ctx.createGain();
    this.lfo.connect(this.lfoGain);
    this.lfo.start();

    const rect = ctx.createWaveShaper();
    rect.curve = absCurve();
    this.envLp = ctx.createBiquadFilter();
    this.envLp.type = "lowpass";
    this.envLp.frequency.value = 14;
    this.envGain = ctx.createGain();
    this.envGain.gain.value = 0;
    this.input.connect(rect).connect(this.envLp).connect(this.envGain);
    this.envTap = ctx.createGain();
    this.envGain.connect(this.envTap);

    this.modBus = ctx.createGain();
    this.lfoGain.connect(this.modBus);
    this.envGain.connect(this.modBus);
    this.modTap = ctx.createGain();
    this.phaseTap = ctx.createGain();
    this.lfoTap = ctx.createGain();
    this.lfoGain.connect(this.lfoTap);

    this.engineIn = ctx.createGain();
    this.input.connect(this.engineIn);
    // re-route the base's dry leg through the THRU offset delay (input → dryDelay → dry)
    this.dryDelay = ctx.createDelay(0.02);
    this.dryDelay.delayTime.value = 0;
    this.input.disconnect(this.dry);
    this.input.connect(this.dryDelay).connect(this.dry);
    this.tone = ctx.createBiquadFilter();
    this.wetPad = ctx.createGain();
    this.tone.connect(this.wetPad).connect(this.wet);

    this.buildEngine();
    this.applySource();
    this.applyTone();
    this.applyMixLaw();
    this.registerParams();
  }

  // ---- mix law ------------------------------------------------------------------------------
  // Send-style dry+wet is what makes the notches (equal dry/wet = deepest), but the SUM of two
  // near-equal signals is +6 dB at the comb peaks — measured +5‥9 dB over the dry's own peak for
  // PHASER/BARBER — and a DJ deck's program is already at 0 dBFS, so that lands as clipping/limiter
  // slam exactly on the transients. Pad BOTH legs by 1/(1+mix): the dry:wet ratio (the notch
  // depth) is untouched, and the coherent worst case dry+wet·mix comes out at exactly unity.
  // Bypassed → 1 (an off effect must be transparent; the base's own ramp handles the wet).
  private applyMixLaw() {
    const g = this.isBypassed ? 1 : 1 / (1 + this.mixAmount);
    const t = this.ctx.currentTime;
    this.dry.gain.setTargetAtTime(g, t, 0.01);
    this.wetPad.gain.setTargetAtTime(g, t, 0.01);
  }
  protected setMix(v: number) {
    super.setMix(v);
    this.applyMixLaw();
  }
  setBypass(on: boolean, hard = false) {
    super.setBypass(on, hard);
    this.applyMixLaw();
  }
  /** How many retired engines are still held (waiting for their fade to clear) — for a harness. */
  get retiredEngines(): number {
    return this.retired.length;
  }
  /** The dry leg's current delay offset in seconds (FLANGER+THRU only) — for a harness recovering the wet. */
  get dryOffsetSec(): number {
    return this._mode === 1 && this._thru ? THRU_DRY_OFFSET : 0;
  }
  /** The live dry-leg gain (the mix-law pad) — for a harness recovering the wet as out − dry·this. */
  get dryLevel(): number {
    return this.isBypassed ? 1 : 1 / (1 + this.mixAmount);
  }

  // ---- engine lifecycle ---------------------------------------------------------------------
  // (Re)build the inner engine between engineIn → … → engineOut → tone. The PREVIOUS engine is
  // not torn down here: it's retired — its engineOut fades to 0 from now, and reapEngines() frees
  // it only once the audio clock is demonstrably past that fade (a wall-clock timer that re-arms
  // until ctx.currentTime agrees, so a suspended/offline context can't tear a still-audible
  // engine). Permanent-node → engine connections (modBus/envTap/modTap → fresh nodes) are undone
  // through each engine's `links`, one edge at a time — never a blanket modBus.disconnect(),
  // which would also sever whatever ELSE taps modBus (the viz's analyser did, and went flat after
  // the first rebuild).
  private buildEngine() {
    this._buildCount++;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    if (this.engine) {
      const old = this.engine;
      old.retiredAt = now;
      old.engineOut.gain.setTargetAtTime(0, now, REBUILD_FADE);
      old.feed.gain.setTargetAtTime(0, now, REBUILD_FADE);
      // the viz picture switches to the new engine immediately (it's only a picture)
      for (const l of old.links) if (l.viz) l.undo();
      old.links = old.links.filter((l) => !l.viz);
      this.retired.push(old);
      this.engine = null;
      this.armReaper();
    }
    const eng: Engine = { nodes: [], scales: [], fbGain: null, fbGains: [], delayNodes: [], oscs: [], links: [], feed: ctx.createGain(), engineOut: ctx.createGain(), retiredAt: 0 };
    this.engine = eng;
    this.engineIn.connect(eng.feed);
    const feed = eng.feed;
    eng.engineOut.gain.value = this.retired.length ? 0 : 1;
    if (this.retired.length) eng.engineOut.gain.setTargetAtTime(1, now, REBUILD_FADE);
    eng.engineOut.connect(this.tone);
    const link = (from: AudioNode, to: AudioNode, out = 0, inp = 0, viz = false) => {
      from.connect(to, out, inp);
      const undo = () => {
        try {
          from.disconnect(to, out, inp);
        } catch {
          /* already gone */
        }
      };
      eng.links.push({ undo, viz });
    };
    // STAGES doubles as every mode's own "density" knob — PHASER's allpass count, CHORUS/FLANGER's
    // voice/tap count, BARBER's engine-pair count. One knob, one range (2‥12), one meaning per mode.
    const density = Math.max(2, Math.min(12, Math.round(this._stages)));

    if (this._mode === 2) {
      // PHASER — an allpass cascade; the LFO/env sweeps every stage's frequency together.
      // Mitigations vs mud: base notches spread EXPONENTIALLY (not piled in the low-mids),
      // lower Q, and a high-pass in the feedback path so regeneration doesn't build low-end.
      // ★ THE SWEEP DRIVES `detune`, NOT `frequency`: frequency·2^(detune/1200) is multiplicative
      // and can never go non-positive however hard it swings (a flat ±Hz swing on `frequency`
      // drove the 200 Hz stage negative at the DEFAULT depth), and a proportional sweep is how a
      // phaser sweeps anyway. PHASER_SWEEP_CENTS = ±1 octave at full depth.
      let prev: AudioNode = feed;
      const aps: BiquadFilterNode[] = [];
      const n = Math.max(1, density - 1);
      for (let i = 0; i < density; i++) {
        const ap = ctx.createBiquadFilter();
        ap.type = "allpass";
        ap.frequency.value = 200 * Math.pow(16, i / n); // 200 Hz‥3.2 kHz, log-spread
        ap.Q.value = 0.5;
        prev.connect(ap);
        prev = ap;
        aps.push(ap);
        eng.nodes.push(ap);
      }
      prev.connect(eng.engineOut);
      const fbHp = ctx.createBiquadFilter();
      fbHp.type = "highpass";
      fbHp.frequency.value = 180;
      fbHp.Q.value = 0; // 0 dB — Chrome's lowpass/highpass Q is in dB; the default 1 dB peak sat in the loop
      const fb = ctx.createGain();
      fb.gain.value = this._fb * 0.8;
      prev.connect(fbHp).connect(fb);
      fb.connect(feed);
      eng.fbGain = fb;
      eng.nodes.push(fbHp, fb);
      const scale = ctx.createGain();
      scale.gain.value = this._depth * PHASER_SWEEP_CENTS * (this.throwing ? 1.6 : 1);
      link(this.modBus, scale);
      for (const ap of aps) scale.connect(ap.detune);
      eng.scales.push({ g: scale, mag: PHASER_SWEEP_CENTS });
      link(this.modBus, this.modTap, 0, 0, true);
    } else if (this._mode === 3) {
      // BARBERPOLE — the "infinite sweep" illusion (Werner et al., DAFx "Barberpole Phasing and
      // Flanging"): comb-delay lines in PAIRS, each pair's two lines swept by their OWN sawtooth
      // ramps (not the shared mod bus — a barberpole needs a monotonic ramp, not a symmetric
      // wobble), locked exactly half a cycle apart, and crossfaded by an envelope derived from a
      // TRIANGLE at the same phase (see ENVELOPE_CURVE for why not from the ramp itself) — so
      // whichever line is mid-sweep is the one you hear, and both wraps are muted in TIME. STAGES sets the PAIR count (density/2, min 1): each pair is independently
      // exact (its two envelopes sum to 1), so N pairs sum to N, corrected back to unity by outGain.
      // Pairs are staggered evenly across the cycle (phase baked into each wave — see barberSaw),
      // so more pairs reads as a denser perpetual sweep, not a louder one.
      const pairs = Math.max(1, Math.round(density / 2));
      const sum = ctx.createGain();
      const outGain = ctx.createGain();
      outGain.gain.value = 1 / pairs;
      sum.connect(outGain);
      outGain.connect(eng.engineOut);
      eng.nodes.push(sum, outGain);
      const rampCurveNow = BARBER_RAMP_CURVES[this._wave] ?? BARBER_RAMP_CURVES[1]; // WAVE: ease/linear/snap
      for (let p = 0; p < pairs; p++) {
        for (const half of [0, 0.5]) {
          const theta = p / pairs + half;
          const saw = ctx.createOscillator();
          saw.setPeriodicWave(barberSaw(ctx, theta));
          saw.frequency.value = this.rate.hz();
          saw.start(now);
          const tri = ctx.createOscillator();
          tri.setPeriodicWave(barberTri(ctx, theta));
          tri.frequency.value = this.rate.hz();
          tri.start(now);
          eng.oscs.push(saw, tri);
          if (p === 0 && half === 0) link(saw, this.modTap, 0, 0, true); // the viz sees line A's ramp

          const toRamp = ctx.createWaveShaper();
          toRamp.curve = rampCurveNow;
          saw.connect(toRamp);
          const rampGain = ctx.createGain();
          rampGain.gain.value = this._depth * BARBER_MAG * (this.throwing ? 1.6 : 1);
          toRamp.connect(rampGain);

          // SOURCE: the envelope follower (already gated LFO/ENV/BOTH by applySource()) taps into
          // the sweep's own DEPTH, additively — a transient momentarily WIDENS the sweep range
          // instead of retuning any oscillator, so it can't touch the phase-lock the crossfade
          // depends on.
          const envDepthTap = ctx.createGain();
          envDepthTap.gain.value = BARBER_MAG * 0.3;
          link(this.envTap, envDepthTap);
          envDepthTap.connect(rampGain.gain);

          // A voice-local input sum: the dry tap PLUS this voice's own feedback, kept isolated
          // from the other voices (feeding back into the shared engineIn would cross-couple every
          // voice's regen into every other — fine at low STAGES, a real stability risk at 12).
          const voiceIn = ctx.createGain();
          feed.connect(voiceIn);

          // 0.1s ceiling, not 0.05: BASE + full-DEPTH sweep (max 0.032s) + a maxed-out envelope
          // depth-tap (up to ~0.024s) can add up to ~0.056s — a DelayNode clamps hard if delayTime
          // automation ever asks for more than its own maxDelayTime.
          const delay = ctx.createDelay(0.1);
          delay.delayTime.value = BARBER_BASE;
          rampGain.connect(delay.delayTime);
          voiceIn.connect(delay);

          const toEnv = ctx.createWaveShaper();
          toEnv.curve = ENVELOPE_CURVE;
          tri.connect(toEnv);
          const g = ctx.createGain();
          g.gain.value = 0; // the envelope (0..1, connected below) IS the whole crossfade weight
          toEnv.connect(g.gain);
          delay.connect(g);
          g.connect(sum);

          // F.BACK: per-voice self-resonance, tapped POST-envelope — the raw delay output has a
          // splice in it at every wrap (20 ms-old audio → 0.2 ms-old audio); tapped before the
          // envelope that splice re-entered the loop unmuted and re-emerged, decaying, once the
          // envelope reopened — a tick per wrap per line, louder with F.BACK. Post-envelope the
          // loop only ever sees the line while it's open. High-passed so it can't build a boom out
          // of these very short (≤20 ms) delays.
          const fbHp = ctx.createBiquadFilter();
          fbHp.type = "highpass";
          fbHp.frequency.value = 300;
          fbHp.Q.value = 0;
          const fb = ctx.createGain();
          fb.gain.value = this._fb * 0.7;
          g.connect(fbHp).connect(fb).connect(voiceIn);
          eng.fbGains.push({ g: fb, mult: 0.7 });

          eng.nodes.push(toRamp, rampGain, envDepthTap, voiceIn, delay, toEnv, g, fbHp, fb);
          eng.scales.push({ g: rampGain, mag: BARBER_MAG });
        }
      }
    } else {
      // CHORUS / FLANGER — STAGES parallel delay-line VOICES (the cubic-interpolated fractional-
      // delay WORKLET per voice; kills the linear-interp HF muffle = the mud), each detuned around
      // the mode's nominal base delay by ±15% AND — the part that makes it an ensemble rather than
      // a static comb — each running its OWN LFO PHASE, k/N of a cycle apart (see the worklet
      // header for why same-phase voices are a wet-killing FIR comb, not a chorus). WAVE/RATE/SYNC
      // are posted to every voice; SOURCE gates the worklet's own LFO (`lfoOn`) and the shared
      // envelope feed. Falls back to native DelayNodes on the shared mod bus if the worklet isn't
      // ready. Voice sum: CHORUS 1/√N (phase-spread voices add in power, and its wet is high-
      // passed so the still-coherent bass can't pump); FLANGER 1/N (its taps sit within 0.84 ms —
      // coherent well up into the mids — so only the safe bound holds).
      const flanger = this._mode === 1;
      const sr = ctx.sampleRate;
      const baseSec = flanger ? THRU_DRY_OFFSET : 0.018; // THRU moves the DRY, not this (see applyThruDelay)
      const magSec = flanger ? 0.0022 : 0.006;
      const fbMult = flanger ? 0.85 : 0.5; // CHORUS gets a modest regen for parity, capped well
      // below FLANGER's — real ensemble chorus rarely feeds back hard.
      const voiceBases = this.voiceBases(baseSec);
      const N = voiceBases.length;
      const voicesOut = ctx.createGain();
      voicesOut.gain.value = 1 / Math.sqrt(N);
      eng.nodes.push(voicesOut);
      if (flanger) voicesOut.connect(eng.engineOut);
      else {
        const hp = ctx.createBiquadFilter();
        hp.type = "highpass";
        hp.frequency.value = CHORUS_WET_HP_HZ;
        hp.Q.value = 0;
        voicesOut.connect(hp).connect(eng.engineOut);
        eng.nodes.push(hp);
      }
      const depthSamples = this._depth * magSec * sr * (this.throwing ? 1.6 : 1);
      voiceBases.forEach((voiceBase, k) => {
        try {
          const node = new AudioWorkletNode(ctx, "moddelay", { numberOfInputs: 2, numberOfOutputs: 3, outputChannelCount: [2, 1, 1], channelCount: 2, channelCountMode: "explicit" });
          feed.connect(node, 0, 0);
          link(this.envTap, node, 0, 1);
          node.connect(voicesOut, 0, 0);
          if (k === 0) {
            // the viz taps voice 0's REAL modulation + phase (worklet outputs 1/2), not the bus
            link(node, this.modTap, 1, 0, true);
            link(node, this.phaseTap, 2, 0, true);
          }
          node.port.postMessage({ base: voiceBase * sr, depth: depthSamples, fb: this._fb * fbMult, lfoHz: this.rate.hz(), wave: this._wave, phase: k / N, lfoOn: this._src === 1 ? 0 : 1 });
          eng.delayNodes.push(node);
          eng.nodes.push(node);
        } catch {
          // Native fallback: one DelayNode per voice on the SHARED mod bus (no per-voice phase —
          // this path is "muddy but functional", not the product). Isolated per-voice feedback.
          const voiceIn = ctx.createGain();
          feed.connect(voiceIn);
          const delay = ctx.createDelay(0.05);
          delay.delayTime.value = voiceBase;
          voiceIn.connect(delay).connect(voicesOut);
          const fb = ctx.createGain();
          fb.gain.value = this._fb * fbMult;
          delay.connect(fb).connect(voiceIn);
          eng.fbGains.push({ g: fb, mult: fbMult });
          eng.nodes.push(voiceIn, delay, fb);
          const scale = ctx.createGain();
          scale.gain.value = this._depth * magSec * (this.throwing ? 1.6 : 1);
          link(this.modBus, scale);
          scale.connect(delay.delayTime);
          eng.scales.push({ g: scale, mag: magSec });
        }
      });
      if (!eng.delayNodes.length) link(this.modBus, this.modTap, 0, 0, true); // native fallback: the bus
    }
  }

  private armReaper() {
    if (this.retireTimer != null) return;
    this.retireTimer = window.setTimeout(() => {
      this.retireTimer = null;
      this.reapEngines();
    }, (REBUILD_FADE * 5 + REBUILD_HOLD) * 1000);
  }
  // Tear down every retired engine whose fade the audio clock has actually finished; re-arm for
  // any that haven't (a suspended context's currentTime doesn't move — a wall-clock deadline
  // alone would splice a still-open engine).
  private reapEngines() {
    const now = this.ctx.currentTime;
    const keep: Engine[] = [];
    for (const e of this.retired) {
      if (now < e.retiredAt + REBUILD_FADE * 5 + REBUILD_HOLD) {
        keep.push(e);
        continue;
      }
      this.teardown(e);
    }
    this.retired = keep;
    if (keep.length) this.armReaper();
  }
  /** ctx times at which retired engines were torn down — a harness hook, nothing reads it in the app. */
  _teardownLog: number[] = [];
  /** ask every live worklet voice for its params — a harness hook. */
  async _probeVoices(): Promise<Record<string, number>[]> {
    const nodes = this.engine?.delayNodes ?? [];
    return Promise.all(nodes.map((n) => new Promise<Record<string, number>>((resolve) => {
      const h = (e: MessageEvent) => { if (e.data?.probe) { n.port.removeEventListener("message", h); resolve(e.data.probe); } };
      n.port.addEventListener("message", h);
      n.port.start();
      n.port.postMessage({ probe: true });
      setTimeout(() => resolve({ timeout: 1 }), 500);
    })));
  }
  /** how many engines buildEngine() has built — a harness hook (boot cost: should be 1 after reset()). */
  _buildCount = 0;
  private teardown(e: Engine) {
    this._teardownLog.push(this.ctx.currentTime);
    for (const l of e.links) l.undo();
    for (const d of e.delayNodes) {
      try {
        d.port.postMessage({ dispose: true });
      } catch {
        /* gone */
      }
    }
    for (const o of e.oscs) {
      try {
        o.stop();
      } catch {
        /* already stopped */
      }
      safeDisconnect(o);
    }
    for (const n of e.nodes) safeDisconnect(n);
    for (const s of e.scales) safeDisconnect(s.g);
    safeDisconnect(e.engineOut);
    safeDisconnect(e.feed);
    try {
      this.engineIn.disconnect(e.feed);
    } catch {
      /* already gone */
    }
  }
  /** Force a pending (debounced) STAGES rebuild to happen NOW — for an offline harness that
   *  would otherwise outrun the wall-clock debounce. Retired engines still crossfade out and are
   *  reaped by the clock-checked reaper, exactly as in the app. Not for the app itself. */
  flushRebuild() {
    if (this.stagesRebuildTimer == null) return;
    window.clearTimeout(this.stagesRebuildTimer);
    this.stagesRebuildTimer = null;
    this.buildEngine();
  }

  // Re-post every worklet voice's live params (chorus/flanger on the worklet path).
  private postVoices(msg: Record<string, number>) {
    if (!this.engine) return;
    for (const n of this.engine.delayNodes) n.port.postMessage(msg);
  }
  private postDelay() {
    if (!this.engine?.delayNodes.length) return;
    const flanger = this._mode === 1;
    const magSec = flanger ? 0.0022 : 0.006;
    const depth = this._depth * magSec * this.ctx.sampleRate * (this.throwing ? 1.6 : 1);
    const fb = this._fb * (flanger ? 0.85 : 0.5);
    this.postVoices({ depth, fb });
  }

  // STAGES voices/taps, spread ±`spread` around one nominal base delay. Shared by buildEngine and
  // modTargets so the viz's comb-null picture always matches what's actually built.
  private voiceBases(nominalSec: number, spread = 0.15): number[] {
    const voices = Math.max(2, Math.min(12, Math.round(this._stages)));
    const out: number[] = [];
    for (let i = 0; i < voices; i++) {
      const t = (i / (voices - 1)) * 2 - 1;
      out.push(nominalSec * (1 + t * spread));
    }
    return out;
  }

  private applyDepth() {
    if (!this.engine) return;
    const boost = this.throwing ? 1.6 : 1;
    for (const s of this.engine.scales) s.g.gain.setTargetAtTime(this._depth * s.mag * boost, this.ctx.currentTime, 0.02);
  }
  private applySource() {
    // LFO is bipolar (±1), the rectified envelope is unipolar (one-directional follow).
    this.lfoGain.gain.setTargetAtTime(this._src === 1 ? 0 : 1, this.ctx.currentTime, 0.02);
    this.envGain.gain.setTargetAtTime(this._src === 0 ? 0 : 4, this.ctx.currentTime, 0.02);
    this.postVoices({ lfoOn: this._src === 1 ? 0 : 1 });
  }
  private applyTone() {
    if (this._tone < 0.5) {
      this.tone.type = "lowpass";
      this.tone.frequency.setTargetAtTime(800 * Math.pow(22.5, this._tone / 0.5), this.ctx.currentTime, 0.02); // 800‥18k
    } else {
      this.tone.type = "highpass";
      this.tone.frequency.setTargetAtTime(20 * Math.pow(100, (this._tone - 0.5) / 0.5), this.ctx.currentTime, 0.02); // 20‥2k
    }
  }

  private setMode(v: number) {
    const next = Math.max(0, Math.min(MOD_MODES.length - 1, Math.round(v)));
    if (next === this._mode) return; // reset()/restore re-set every param — an unchanged mode is not a rebuild
    this._mode = next;
    this.buildEngine();
    this.applyThruDelay();
  }
  // The live LFO frequency (SYNC division of the tempo, else the free 0.05‥10 Hz knob) lives in
  // the shared SyncRate; the device re-applies it to the oscillator, to every worklet voice (each
  // is phase-continuous, so this never jumps a delay), and to BARBER's ramps — those all change
  // together, so they keep the phase offsets baked into their waves.
  private applyRate() {
    const hz = this.rate.hz();
    this.lfo.frequency.setTargetAtTime(hz, this.ctx.currentTime, 0.02);
    if (this.engine) for (const o of this.engine.oscs) o.frequency.setTargetAtTime(hz, this.ctx.currentTime, 0.02);
    this.postVoices({ lfoHz: hz });
  }
  private setRate(e: number) {
    this.rate.setRate(e);
    this.applyRate();
  }
  private setSync(on: boolean) {
    this.rate.setSync(on);
    this.applyRate();
  }
  /** Panel feeds the deck's live BPM so a synced LFO tracks tempo changes. */
  setSyncBpm(bpm: number) {
    if (this.rate.setBpm(bpm)) this.applyRate();
  }
  private setDepth(e: number) {
    this._depth = clamp01(e);
    this.applyDepth();
    this.postDelay();
  }
  private setFeedback(e: number) {
    this._fb = clamp01(e);
    const eng = this.engine;
    if (eng?.fbGain) eng.fbGain.gain.setTargetAtTime(this._fb * 0.8, this.ctx.currentTime, 0.02); // PHASER
    if (eng) for (const f of eng.fbGains) f.g.gain.setTargetAtTime(this._fb * f.mult, this.ctx.currentTime, 0.02);
    this.postDelay();
  }
  private setTone(e: number) {
    this._tone = clamp01(e);
    this.applyTone();
  }
  // STAGES is every mode's own density knob (PHASER stages, CHORUS/FLANGER voices/taps, BARBER
  // engine pairs) — never a no-op, so it always rebuilds. ★ DEBOUNCED: dragging STAGES fires
  // setParam on every integer step it crosses, and each rebuild instantiates up to 12 worklet
  // processors ON THE RENDER THREAD — only the value you actually STOP on gets built.
  private setStages(v: number) {
    const next = Math.max(2, Math.min(12, Math.round(v)));
    if (next === this._stages && this.stagesRebuildTimer == null) return; // same density → nothing to rebuild
    this._stages = next;
    if (this.stagesRebuildTimer != null) window.clearTimeout(this.stagesRebuildTimer);
    this.stagesRebuildTimer = window.setTimeout(() => {
      this.stagesRebuildTimer = null;
      this.buildEngine();
    }, 120);
  }
  // WAVE reshapes BARBER's own ramp curve (a rebuild — it's baked into a WaveShaper), the shared
  // LFO's waveform (a live swap) and every worklet voice's own LFO (a post).
  private setWave(v: number) {
    const next = Math.max(0, Math.min(MOD_WAVES.length - 1, Math.round(v)));
    if (next === this._wave) return;
    this._wave = next;
    this.lfo.type = oscType(this._wave);
    this.postVoices({ wave: this._wave });
    if (this._mode === 3) this.buildEngine();
  }
  private setSrc(v: number) {
    this._src = Math.max(0, Math.min(MOD_SOURCES.length - 1, Math.round(v)));
    this.applySource();
  }
  private setThru(on: boolean) {
    if (on === this._thru) return;
    this._thru = on;
    if (this._mode === 1) this.buildEngine(); // THRU only changes FLANGER's build
    this.applyThruDelay();
  }
  // ★ THRU-ZERO IS A DRY OFFSET, NOT A SHORTER WET. The old THRU just moved FLANGER's base delay
  // from 2.8 ms to 0.4 ms with the same ±2.2 ms swing — the wet asked for NEGATIVE delays half
  // the cycle and the worklet clamped at 1 sample: a held minimum, never a crossing. Real
  // through-zero (tape) flanging is the WET passing THROUGH the dry's own delay: the dry gets a
  // fixed offset equal to the wet's nominal base, so the RELATIVE delay sweeps −2.2‥+2.2 ms and
  // crosses zero — every comb null flies to infinity at the crossing and the pattern mirrors on
  // the far side (the "jet"). Ramped, not stepped: 2.8 ms of dry latency arriving over 60 ms is a
  // ~5% pitch dip for a moment, a splice would be a click. Only ever non-zero for FLANGER+THRU;
  // bypass leaves it where it is (an armed THRU keeps its 2.8 ms of latency, harmless).
  private applyThruDelay() {
    const target = this._mode === 1 && this._thru ? THRU_DRY_OFFSET : 0;
    this.dryDelay.delayTime.setTargetAtTime(target, this.ctx.currentTime, 0.02);
  }

  /** Pad-throw TRIGGER: engage (un-bypass if dormant) + deepen the swirl (depth + feedback)
   *  while held; release restores it and re-bypasses if it was off. No throwMix override needed —
   *  the base class's default (paramDefault("mix")) is MOD's own 0.5 construction default, the
   *  comb-filter's deepest-notch point, so a throw can neither go silent nor erase the notches. */
  protected applyThrowBoost(on: boolean) {
    this.applyDepth();
    const bump = on ? 0.2 : 0;
    const eng = this.engine;
    // ★ PHASER's throw bump is capped at PHASER_LOOP_MAX, not 0.95: the cascade is TIME-VARYING
    // (12 allpasses swept ±1.6 octaves under throw), and a modulated allpass is not energy-
    // neutral — at 0.95 the loop ran away +40 dB in 20 s on pink noise (fxlab --mod-audit,
    // stability-phaser-throw), which on a real deck is the master brickwall slamming and, given
    // long enough, Inf. A held pad throw must be a build-up that STOPS.
    if (eng?.fbGain) eng.fbGain.gain.setTargetAtTime(Math.min(PHASER_LOOP_MAX, this._fb * 0.8 + bump), this.ctx.currentTime, 0.02);
    if (eng) for (const f of eng.fbGains) f.g.gain.setTargetAtTime(Math.min(0.95, this._fb * f.mult + bump * f.mult), this.ctx.currentTime, 0.02);
    this.postDelay();
  }

  // Live reads for the viz.
  get modeIndex() {
    return this._mode;
  }
  get rateHz() {
    return this.rate.hz();
  }
  get synced() {
    return this.rate.sync;
  }
  get divLabel() {
    return this.rate.divLabel;
  }
  get stages() {
    return this._stages;
  }
  /** The live modulation signal — for the viz to tap ONCE and read the real sweep across every
   *  rebuild (a stable node, re-fed by buildEngine): the LFO+envelope bus for CHORUS/FLANGER/PHASER
   *  (voice 0's own phase for the worklet voices — an honest picture of one of them, not a
   *  fabricated stand-in), line A's raw ramp for BARBER. */
  get modSignal(): AudioNode {
    return this.modTap;
  }
  /** The tapped voice's live LFO PHASE (0..1) as a signal — CHORUS/FLANGER on the worklet path
   *  only (see phaseTap); silent in the other modes, where the viz derives phase from modSignal. */
  get phaseSignal(): AudioNode {
    return this.phaseTap;
  }
  /** The native LFO alone (±1, zero in ENV mode) — the phase reference for modes that run on the
   *  shared bus (PHASER, the native fallback). */
  get lfoSignal(): AudioNode {
    return this.lfoTap;
  }
  /** True when phaseSignal carries a real phase (worklet voices are live). */
  get hasPhaseSignal(): boolean {
    return this._mode < 2 && !!this.engine?.delayNodes.length;
  }
  get pairs(): number {
    return Math.max(1, Math.round(Math.max(2, Math.min(12, Math.round(this._stages))) / 2));
  }
  /** One drawable target: a comb null / allpass notch frequency, tagged with WHICH voice / pair
   *  it belongs to (0 = the tapped one) so a viz can group and fade them. */
  /** The comb-notch / allpass-notch frequencies for a live mod value `m` (the tapped voice's
   *  modulation, ±; BARBER: line A's ramp value) and, when the engine reports one, the tapped
   *  voice's LFO `phase` (0..1). Every other voice/pair is placed relative to that: CHORUS/FLANGER
   *  voice k at phase + k/N on the same wave (its own envelope share added), BARBER pair p at
   *  ramp phase + p/pairs with whichever of its two lines is currently open. The viz reads `m`
   *  and `phase` off modSignal/phaseSignal and draws THESE sweeping. */
  modTargets(m: number, phase?: number): { hz: number; group: number }[] {
    const boost = this.throwing ? 1.6 : 1;
    const out: { hz: number; group: number }[] = [];
    const combs = (delaySec: number, group: number) => {
      let d = Math.abs(delaySec);
      if (d < 0.00005) d = 0.00005;
      for (let j = 0; j < 16; j++) {
        const f = (j + 0.5) / d;
        if (f >= 20000) break;
        if (f > 25) out.push({ hz: f, group });
      }
    };
    if (this._mode === 2) {
      // Multiplicative, matching detune's own semantics (see buildEngine's PHASER branch).
      const n = Math.max(1, this._stages - 1);
      const cents = m * this._depth * PHASER_SWEEP_CENTS * boost;
      const ratio = Math.pow(2, cents / 1200);
      for (let i = 0; i < this._stages; i++) {
        const f = 200 * Math.pow(16, i / n) * ratio;
        if (f > 25 && f < 20000) out.push({ hz: f, group: 0 });
      }
      return out;
    }
    if (this._mode === 3) {
      // `m` is line A's raw saw (−1..1). Pair p's saw sits 2p/pairs further along; within a
      // pair, the OPEN line is the one whose saw is nearer 0 (its triangle is high there — see
      // ENVELOPE_CURVE), i.e. fold the pair's position into (−0.5, 0.5]. The delay follows the
      // WAVE ramp curve exactly as the engine's WaveShaper does (held past ±RAMP_GUARD).
      const pairs = this.pairs;
      const range = this._depth * BARBER_MAG * boost;
      for (let p = 0; p < pairs; p++) {
        let x = m + (2 * p) / pairs;
        x = x - 2 * Math.floor((x + 1) / 2); // wrap into [−1, 1)
        if (x > 0.5) x -= 1;
        else if (x <= -0.5) x += 1; // the open line of this pair
        const u = clamp01((x / (1 - RAMP_GUARD) + 1) / 2);
        combs(BARBER_BASE + range * barberRampShape(this._wave, u), p);
      }
      return out;
    }
    // CHORUS / FLANGER — one voice's worth of nulls per STAGES voice (see voiceBases), each at its
    // own LFO phase (k/N of a cycle from the tapped one) on the engine's own wave shape, plus the
    // envelope share every voice gets alike (m minus the tapped voice's LFO value).
    const flanger = this._mode === 1;
    const magSec = flanger ? 0.0022 : 0.006;
    // under THRU the picture is the delay RELATIVE to the offset dry: it crosses zero
    const nominal = flanger ? THRU_DRY_OFFSET : 0.018;
    const bases = this.voiceBases(nominal).map((b) => (flanger && this._thru ? b - THRU_DRY_OFFSET : b));
    const lfoOn = this._src !== 1;
    let p0: number;
    let env: number;
    if (phase != null && lfoOn) {
      p0 = phase;
      env = m - modLfoShape(this._wave, p0);
    } else if (lfoOn) {
      p0 = Math.asin(Math.max(-1, Math.min(1, m))) / (2 * Math.PI); // no phase report: sine guess
      env = 0;
    } else {
      p0 = 0;
      env = m;
    }
    bases.forEach((voiceBase, k) => {
      const mk = (lfoOn ? modLfoShape(this._wave, p0 + k / bases.length) : 0) + env;
      combs(voiceBase + mk * this._depth * magSec * boost, k);
    });
    return out;
  }

  private registerParams() {
    this.params.push(
      { id: "mode", def: 0, get: () => this._mode, set: (v) => this.setMode(v) },
      { id: "rate", def: 0.3, get: () => this.rate.ext, set: (v) => this.setRate(v) },
      { id: "depth", def: 0.5, get: () => this._depth, set: (v) => this.setDepth(v) },
      { id: "feedback", def: 0.3, get: () => this._fb, set: (v) => this.setFeedback(v) },
      { id: "tone", def: 0.5, get: () => this._tone, set: (v) => this.setTone(v) },
      { id: "stages", def: 6, get: () => this._stages, set: (v) => this.setStages(v) },
      { id: "wave", def: 0, get: () => this._wave, set: (v) => this.setWave(v) },
      { id: "src", def: 0, get: () => this._src, set: (v) => this.setSrc(v) },
      { id: "thru", def: 0, get: () => (this._thru ? 1 : 0), set: (v) => this.setThru(v >= 0.5) },
      { id: "sync", def: 0, get: () => (this.rate.sync ? 1 : 0), set: (v) => this.setSync(v >= 0.5) },
    );
  }

  dispose() {
    if (this.stagesRebuildTimer != null) window.clearTimeout(this.stagesRebuildTimer);
    if (this.retireTimer != null) window.clearTimeout(this.retireTimer);
    try {
      this.lfo.stop();
    } catch {
      /* already stopped */
    }
    if (this.engine) this.teardown(this.engine);
    this.engine = null;
    for (const e of this.retired) this.teardown(e);
    this.retired = [];
    super.dispose();
  }
}
