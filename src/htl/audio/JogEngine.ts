import { scratchOffset, type ScratchKind } from "./scratchPatterns";
import { lerp } from "../../util/math";

// The transport surface the jog physics drives. Deck implements this with bound
// callbacks so the engine never touches the clock/stretch internals directly (mirrors
// the LoopEngine composition). The engine OWNS the platter state + the scratch resampler
// node; the host owns the clock, the buffer-source voice, and the pitch-bend.
export interface JogHost {
  position(): number; // current playhead (sec)
  startOffset(): number;
  setStartOffset(v: number): void;
  playing(): boolean;
  setPlaying(v: boolean): void;
  loaded(): boolean;
  duration(): number;
  rate(): number; // _rate — the set play speed the coast catches up to
  effRate(): number; // current sounding rate (brake seeds from this)
  play(): void; // instant transport (fallbacks when Vinyl Speed is off)
  pause(): void;
  spawnSource(at: number): void; // (re)start the stretch-engine voice at `at`
  stopSource(): void; // hand the audio to the scratch resampler
  clearBend(): void; // a grab/ramp takes over the clock — drop any decaying bend
  connectScratch(node: AudioWorkletNode): void; // node.connect(deck channel input)
  slipArm(): void; // SLIP: anchor the shadow playhead at grab (no-op unless slip on + playing)
  slipArmForce(): void; // CENSOR: anchor the shadow regardless of the slip toggle (still playing-only)
  slipReleasePos(): number | null; // SLIP: where the track would be now, or null (no anchor)
  loopBounds(): { start: number; end: number } | null; // the active loop's ring, or null (no loop / inactive)
}

// Brake and catch-up-to-play are TWO DIFFERENT PHYSICAL PROCESSES, not one curve — brake is
// a hand (or pad) FRICTION-stopping a spinning platter; catch-up (soft-start, spinback
// recovery, a natural jog release back to play) is a MOTOR SERVO driving the platter to a
// target speed against comparatively small friction. Modelling both as one fixed-tau
// exponential — or one hand-tuned "shrinking tau" curve, as an earlier pass here did — has
// no principled reason to feel right, because it isn't matched to either mechanism. Both
// models below are instead anchored to real, citable numbers rather than reverse-engineered
// from any one product's undisclosed curve (Pioneer's own brake, per patent US6751167B2, is
// itself just a hand-tuned lookup table — no reason to treat it as ground truth). Verified
// numerically (stability + settling-time sweeps) before landing here — see the design notes
// in htl-jog-rearchitecture-plan.md.

// --- Catch-up-to-play: a torque-driven 2nd-order servo step response (T = I·α, not friction) ---
// Anchored to a real, published spec: the Technics SL-1200 direct-drive turntable reaches
// 33⅓ rpm from a standstill in 0.7s — the reference vinyl motor DJ culture (and rekordbox's
// own "vinyl mode") implicitly benchmarks against. `tau` keeps its existing meaning (the
// user-facing knob's seconds), now read as "desired 2%-settling time"; SERVO_OMEGA_TAU is the
// omegaN·tau product (at SERVO_ZETA damping) that reproduces the real 0.7s spec — verified by
// simulation, not just derived, including at the actual 16-50ms frame-rate range this runs at.
// Slightly overdamped (zeta>1) for headroom against any audible wobble on spin-up.
const SERVO_OMEGA_TAU = 6.64;
const SERVO_ZETA = 1.05;
export interface ServoState {
  v: number; // velocity
  a: number; // acceleration (the 2nd-order state a fixed-tau exponential doesn't have)
}
// Explicit (semi-implicit) Euler integration of a 2nd-order system is only stable while
// omegaN·dt stays small — verified numerically: clean up to ~0.7, diverging to infinity by
// ~0.9. A SHORT tau (the natural-release taus run as low as 0.025s) combined with a real rAF
// hiccup (dt clamped up to 0.05s) can push omegaN·dt well past that on its own, so this
// sub-steps down to a safe size instead of trusting the caller's dt — caught by this file's
// own test suite blowing up before it ever reached production.
const SERVO_STABLE_OMEGA_DT = 0.5;
export function servoStep(state: ServoState, target: number, dt: number, tau: number): ServoState {
  if (tau <= 0) return { v: target, a: 0 };
  const omegaN = SERVO_OMEGA_TAU / tau;
  const steps = Math.max(1, Math.ceil((omegaN * dt) / SERVO_STABLE_OMEGA_DT));
  const subDt = dt / steps;
  let v = state.v;
  let a = state.a;
  for (let i = 0; i < steps; i++) {
    const accel = omegaN * omegaN * (target - v) - 2 * SERVO_ZETA * omegaN * a;
    a += accel * subDt;
    v += a * subDt;
  }
  return { v, a };
}

// --- Brake: a simplified LuGre friction/stiction model (Canudas de Wit et al. 1995) ---
// Models a hand (or the physical jog-tension pad) gripping the platter to a stop — real
// friction, real stiction, unlike a fixed-tau exponential's "viscous only" glide that never
// quite finishes (the exact flaw Mixxx's own maintainers flag in their alpha-beta-driven
// ramp, unfixed since 2019: mixxxdj/mixxx#9573, #10700). BRAKE_FS_FC_RATIO is the
// static/kinetic friction ratio for FELT — not a guess: AlphaTheta's own patent (EP3989600A1)
// discloses the physical jog-tension pads ARE felt, and measured felt-on-metal (0.323/0.281)
// and felt-on-wood (0.452/0.392) tribology data both give ~1.15. BRAKE_FC_COEFF/BRAKE_SIGMA0
// set the friction magnitude relative to tau; tuned by simulation (stability holds across the
// full dt/tau/velocity range this actually runs at) rather than hand-derived — the first
// attempt at this got the timescale wrong by hand, this one was checked numerically first.
const BRAKE_FS_FC_RATIO = 1.15;
const BRAKE_VS = 0.15; // ×realtime — Stribeck velocity scale where the grab engages
const BRAKE_FC_COEFF = 0.3;
const BRAKE_SIGMA0_COEFF = 8;
export interface BrakeState {
  v: number; // velocity (target is always 0 — braking is always to a stop)
  z: number; // bristle deflection
}
export function brakeFriction(state: BrakeState, dt: number, tau: number): BrakeState {
  if (tau <= 0) return { v: 0, z: 0 };
  const v = state.v;
  if (v === 0) return state;
  const fc = BRAKE_FC_COEFF * tau;
  const fs = BRAKE_FS_FC_RATIO * fc;
  const g = fc + (fs - fc) * Math.exp(-((v / BRAKE_VS) ** 2));
  const zdot = v - (Math.abs(v) * state.z) / g;
  const z = state.z + zdot * dt;
  const sigma0 = BRAKE_SIGMA0_COEFF / (BRAKE_FC_COEFF * tau);
  const sigma2 = 1 / tau; // matches the old plain-exponential far-field rate
  const F = sigma0 * z + sigma2 * v;
  const next = v - F * dt;
  if (next > 0 !== v > 0) return { v: 0, z: 0 }; // overshoot → a decisive, exact stop
  return { v: next, z };
}

// --- A released record on a turning platter: CONSTANT torque, not a servo ---
// Operator, 2026-11-10 (FLX4, vinyl mode): "the backspin on rekordbox is more aggressive and I can't
// quite match the feel or sound of it". A thrown record is not driven by a speed controller. On a
// real deck the motor holds the heavy platter at speed and the record slips on the slipmat; kinetic
// (Coulomb) friction is the same at any slip speed, so the record's speed changes at a CONSTANT rate
// until it matches the platter and locks: a backward throw slows LINEARLY through zero and on up to
// play speed, a forward throw faster than play slows linearly down to it. The servo used before gave a
// backspin a long soft exponential tail around zero (measured: about 0.3 s of creeping under 0.3x), and
// the FLX4's own free spin (exponential, ~0.145 s, measured on the operator's capture) gave it a
// second one. Numbers: a 180 g record (I = 2.0e-3 kg m^2) on felt (mu_k ~0.3, contact radius ~0.1 m)
// has ~0.053 N m of drag, ~26 rad/s^2, i.e. about 7.5x play speed per second at 33 1/3; DJ slipmats
// run 6-16x/s across mats and needle weights. The mass knob picks within that (platterTaus.catchAccel),
// and Back spin length picks the triggered spinback's (platterTaus.backSpinAccel).
// `accel` is in play-speeds per second (× realtime per second).
export function motorStep(v: number, target: number, dt: number, accel: number): number {
  if (!(accel > 0)) return target;
  const m = accel * dt;
  const dv = target - v;
  return dv > m ? v + m : dv < -m ? v - m : target;
}

// --- The knob → time-constant mappings, exported so Settings ▸ Platter can draw the deck's own
// curves with the deck's own numbers (servoStep/brakeFriction above + these). One definition; a
// graph that re-derived them would be a second copy free to drift.
export const platterTaus = {
  /** Released while playing: the slipmat's catch, in play-speeds per second (motorStep). 0→1x takes
   *  60 ms featherweight … 160 ms heavy (100 ms at the default mass), so a 10x backspin runs ~1.1 s. */
  catchAccel: (weight: number) => 1 / lerp(0.06, 0.16, weight),
  /** Released and settling to a stop (paused, or too gentle to catch up): friction time. */
  glide: (weight: number, drag: number) => lerp(0.6, 0.1, drag) * lerp(0.7, 1.3, weight),
  brake: (b: number) => lerp(0.02, 0.5, b),
  start: (s: number) => lerp(0.02, 0.45, s),
  /** The FX2 SPIN move's wind-down to rest (friction, brakeFriction). */
  backSpin: (b: number) => lerp(0.12, 0.6, b),
  backSpinStrength: (b: number) => lerp(4, 14, b),
  /** A spinback's catch (a triggered one, or a hard backward jog throw), play-speeds per second:
   *  Short = a grippy mat, Long = a slippery one. With the strength above a triggered spinback runs
   *  0.3 s (Short, 4x) … 0.9 s (default, 9x) … 2.1 s (Long, 14x) back to play. */
  backSpinAccel: (b: number) => lerp(16, 7, b),
  /** ★ How far a hard backward jog flick may throw the track back, in seconds of audio (operator,
   *  2026-11-10: "the throwback length on the backspin is a little drastic, it spins a bit too
   *  long"). The distance of a constant-friction catch grows with the SQUARE of the throw speed
   *  (v^2 / 2a), so at the 20x cap and the default catch it went back ~17 s over ~2 s. A throw that
   *  would go further gets a grippier catch instead: gentle and medium flicks are untouched, a hard
   *  one is a snappier spin of bounded length. Short 1.5 s … default 3.75 s … Long 6 s. */
  backSpinMaxBack: (b: number) => lerp(1.5, 6, b),
};
/** The fastest a jog spinback is thrown (x realtime): the top of a real 33 1/3 platter's backward fling. */
export const SPINBACK_MAX_VEL = 14;
/** Settings ▸ Platter has ONE "mass" knob (operator, 2026-11-02: weight and drag merged). A heavier
 *  platter both catches up slower AND glides longer, so drag falls as mass rises; 0.8 − mass keeps
 *  the long-standing default (0.4 / 0.4) exactly where it was. */
export const platterDrag = (mass: number) => Math.max(0, Math.min(1, 0.8 - mass));

// --- Release classification (Phase B: extracted for its own sake, prep for Phase C) ---
// What happens when the finger lifts is a real, bug-prone decision — three distinct outcomes
// depending on how the platter was moving — but it lived inline inside scrubEnd(), entangled
// with the host/worklet side effects, so it was only ever testable through the full class with
// a fake host. Pulled out the same way src/htl/room/sessionFollow.ts pulls the session-sync
// follower's decisions out of useSessionSync: a pure function, an input struct, a discriminated
// union of actions — the caller (scrubEnd) performs the side effect the action names.
export type ReleaseAction =
  | { kind: "slip"; pos: number } // SLIP was armed — snap straight to the shadow, no coast at all
  | { kind: "spinback"; vel: number; accel: number } // a hard backward flick while playing — the dramatic back-spin-and-catch curve
  | { kind: "coast"; vel: number }; // a normal release — hand the platter its fling velocity

export interface ReleaseInput {
  handVel: number; // the platter's speed at release (timestamped ticks, else the frame-smoothed finger)
  jogReturnToPlay: boolean; // was the deck playing when grabbed
  slipPos: number | null; // SLIP shadow position, or null (not armed)
  backSpinAccel: number; // the spinback's catch (play-speeds per second, platterTaus.backSpinAccel)
  maxCoast: number; // release-speed cap (× realtime)
  spinbackFlick: number; // backward-flick speed past which a release counts as a spinback gesture
  spinbackMaxBack?: number; // seconds of audio a spinback may travel backward (platterTaus.backSpinMaxBack)
}

export function decideRelease(p: ReleaseInput): ReleaseAction {
  if (p.slipPos != null) return { kind: "slip", pos: p.slipPos };
  const vel = Math.max(-p.maxCoast, Math.min(p.maxCoast, p.handVel));
  // The FLX4 (and Pioneer gear in general) has no dedicated spinback button — the native
  // gesture is a hard BACKWARD flick of the jog while playing.
  if (p.jogReturnToPlay && vel < -p.spinbackFlick) {
    const v = Math.max(vel, -SPINBACK_MAX_VEL);
    // backward travel of the catch is v^2 / 2a: past the limit, catch harder rather than travel further
    const accel = p.spinbackMaxBack != null && p.spinbackMaxBack > 0 ? Math.max(p.backSpinAccel, (v * v) / (2 * p.spinbackMaxBack)) : p.backSpinAccel;
    return { kind: "spinback", vel: v, accel };
  }
  return { kind: "coast", vel };
}

// rekordbox-style jog / platter physics: the scratch resampler driver + the weighted-
// platter grab/coast + the Vinyl Speed Adjust motor ramps (brake / soft-start / spinback).
// Extracted from Deck so the scratch surface is debuggable on its own; behaviour is 1:1.
export class JogEngine {
  // Cap on release speed (× realtime). It was 3, which turned every hard throw into a 3x one: a real
  // 33 1/3 platter flung backward reaches 8-15x, and the operator's FLX4 capture spins free at 13-16x
  // right after a backspin. 20 keeps headroom under the scratch resampler's 24x granular switch.
  private static readonly MAX_COAST = 20;
  // Pointer drags (no controller timestamps) keep the old cap: a waveform drag zoomed out reads tens
  // of x and, let go on a paused deck, would glide seconds of audio away.
  private static readonly POINTER_MAX_COAST = 3;
  private static readonly SPINBACK_FLICK = 2.2; // release speed (× realtime) past which a BACKWARD jog flick = a spinback
  // The release speed of a controller jog is the least-squares slope of its timestamped ticks over
  // this much of the latest motion (frame-rate smoothing of the hand underestimated a fast flick).
  static readonly FLING_WINDOW_MS = 25;

  private jogPhase: "off" | "grab" | "coast" | "reverse" | "motor" | "pattern" = "off"; // "motor" = a worklet-owned brake/spinback/soft-start ramp
  private jogPos = 0; // platter position (track sec) — authoritative while jogging
  private jogVel = 0; // sounding velocity (track-sec / real-sec, signed)
  private handPos = 0; // where the finger says the platter is (accumulated)
  private handLast = 0; // handPos at the previous frame tick (for frame-rate fling velocity)
  private handVel = 0; // smoothed finger velocity, drives pitch + release fling
  private jogInputAt = 0; // ctx time of the last pointer sample (for per-input motion)
  private jogLast = 0; // ctx time of the last tick
  private lastMoveAt = 0; // performance.now() ms of the last scratchMove post — see scratchMove()
  private jogRaf = 0; // requestAnimationFrame handle (0 = loop idle)
  private jogReturnToPlay = false; // release should spin back up to play, not rest
  private _jogWeight = 0.4; // 0 = featherweight/snappy … 1 = heavy flywheel
  private _jogDrag = 0.4; // 0 = frictionless glide … 1 = quick brake
  // --- Vinyl Speed Adjust: turntable motor brake / soft-start ramps + spinback ---
  // rekordbox's "vinyl feel": PAUSE decelerates to a stop (Touch/Brake), PLAY spins up
  // from rest (Release/Start), and spinback() throws it backward then catches it. All
  // reuse the jog COAST physics (stepCoast) — a motor ramp is just a coast with a start
  // velocity and a time set by these knobs (not the jog weight/drag). Off → instant.
  private _vinylSpeed = false; // master enable (turntable motor feel; opt-in so scratch stays instant)
  private _vinylBrake = 0.22; // 0..1 → pause-brake + touch-decel time
  private _vinylStart = 0.18; // 0..1 → play soft-start time
  private _backSpin = 0.5; // 0..1 → spinback length + strength
  private _ramping: "start" | "brake" | "spinback" | null = null; // a motor ramp is in flight
  private _coastTau = 0; // >0 overrides the jog-physics coast tau (= a motor ramp time)
  private _catchAccel = 0; // >0 overrides the mass knob's catch (a jog spinback uses the Back spin knob's)
  // Timestamped hand samples [ts ms, unwrapped hand position sec, ...] for the release speed, from
  // moves that carried a controller timestamp. trailTs = whether the LATEST move had one.
  private trail: number[] = [];
  private trailPos = 0;
  private trailTs = false;
  private _brakeZ = 0; // brakeFriction's bristle-deflection state (JS-side coast, decay-to-stop only)

  // The continuous scrub resampler (attached by AudioEngine), owned here. It reads PCM
  // live out of a registry shared with the stretch worklet (both processors load into the
  // same AudioWorkletGlobalScope — see scratchWorklet.ts's header comment), so there is no
  // PCM transfer to it at all from here: whatever stretch has resident, scratch can read,
  // desktop or mobile, full track or stems — the old windowed-PCM-extraction path (a
  // separate copy pulled from the worklet via extractRegion when the deck's own buffer was
  // freed) no longer exists.
  private scratchNode: AudioWorkletNode | null = null;

  constructor(private readonly ctx: AudioContext, private readonly host: JogHost) {}

  // --- scratch resampler wiring ---

  /** Wire the scratch resampler in parallel with the source, into the EQ (raw pitch,
   *  bypassing key-lock — scrubbing should pitch like vinyl). */
  attachNode(node: AudioWorkletNode) {
    this.host.connectScratch(node);
    this.scratchNode = node;
    node.port.onmessage = (e) => this.onScratchMessage(e.data); // worklet-ramp position + done
  }
  // A worklet-owned motor ramp (brake / spinback / soft-start) reports its read position back
  // for the visual playhead, then a 'rampDone' when it settles — at which point we either
  // resume normal playback (spinback catch / soft-start) or stay paused (brake).
  private onScratchMessage(d: { type: string; pos: number }) {
    if (this.jogPhase !== "motor") return; // stale message from a cancelled ramp
    if (d.type === "rampPos") {
      this.jogPos = d.pos / this.ctx.sampleRate;
      this.host.setStartOffset(this.jogPos);
    } else if (d.type === "rampDone") {
      this.jogPos = d.pos / this.ctx.sampleRate;
      this.clampJog();
      const resume = this.jogReturnToPlay;
      this.jogPhase = "off";
      this._ramping = null;
      this._coastTau = 0;
      this.jogVel = 0;
      this.host.setStartOffset(this.jogPos);
      if (resume) {
        // The scratch voice fades out (gain→0 in the worklet) as the deck source fades in.
        this.host.spawnSource(this.jogPos);
        this.host.setPlaying(true);
      }
    }
  }
  get attached() {
    return this.scratchNode != null;
  }
  /** Forward a stem's live gain (mute/level) to the scratch worklet, same message shape Deck
   *  already posts to the stretch/playback worklet — so a scratch reflects the current mix
   *  instead of always summing every group at unity regardless of what's muted. */
  postStemGain(index: number, value: number) {
    this.scratchNode?.port.postMessage({ type: "stemGain", index, value });
  }

  private scratchStart() {
    this.lastMoveAt = 0; // a fresh grab must not inherit a stale gap from a previous one
    this.scratchNode?.port.postMessage({ type: "start", pos: this.jogPos * this.ctx.sampleRate });
  }
  /** `ts` = when this motion happened, on the performance.now() clock: a controller tick's own
   *  MIDIMessageEvent.timeStamp, else now. The worklet's speed tracker fits position against it. */
  private scratchMove(ts?: number) {
    // Position, plus the REAL wall-clock gap since the last post (performance.now(), sub-ms —
    // not the worklet's own render-quantum-quantized sample counter). A hardware jog's MIDI
    // delivery is bursty: measured on a real DDJ-FLX4 capture, a third of consecutive jog ticks
    // land within the same ~2.9ms render quantum, so the worklet's internal timer can't tell
    // them apart and was falling back to a fixed ~16.7ms (60Hz-frame) guess — ~4x too slow vs
    // the tick stream's real average rate, which reads as the jog understating fast motion.
    // dtMs lets the worklet use the true gap instead. (Position is otherwise authoritative
    // either way — this only sharpens the DERIVED velocity used for anti-alias/pitch-smoothing
    // and the continuous/granular mode switch, not the platter's actual reported location.)
    const now = performance.now();
    const dtMs = this.lastMoveAt > 0 ? now - this.lastMoveAt : 0;
    this.lastMoveAt = now;
    // hw: a controller tick with its own timestamp. A micro jog from one is played as the hand's
    // tick-by-tick trajectory (scratchWorklet HAND TRAJECTORY); pointer input, whose coalesced
    // events share one post time, keeps the chase pacing.
    this.scratchNode?.port.postMessage({ type: "move", pos: this.jogPos * this.ctx.sampleRate, dtMs, ts: ts ?? now, hw: ts !== undefined });
  }
  private scratchStop() {
    this.scratchNode?.port.postMessage({ type: "stop" });
  }

  // --- settings ---

  /** Tune the platter feel. Both 0..1. weight = inertia, drag = coast friction. */
  setJogPhysics(weight: number, drag: number) {
    this._jogWeight = Math.max(0, Math.min(1, weight));
    this._jogDrag = Math.max(0, Math.min(1, drag));
  }
  /** Vinyl Speed Adjust — the turntable motor feel. enabled=false restores instant
   *  play/pause + a dead platter stop. brake/start are 0..1 (→ stop / spin-up times). */
  setVinylSpeed(enabled: boolean, brake: number, start: number) {
    this._vinylSpeed = enabled;
    this._vinylBrake = Math.max(0, Math.min(1, brake));
    this._vinylStart = Math.max(0, Math.min(1, start));
  }
  /** Spinback length + strength, 0..1 (Short … Long). */
  setBackSpinLength(v: number) {
    this._backSpin = Math.max(0, Math.min(1, v));
  }
  // Motor ramp time-constants / strength from the 0..1 knobs.
  private brakeTau() {
    return platterTaus.brake(this._vinylBrake);
  }
  private startTau() {
    return platterTaus.start(this._vinylStart);
  }
  private backSpinTau() {
    return platterTaus.backSpin(this._backSpin);
  }
  private backSpinStrength() {
    return platterTaus.backSpinStrength(this._backSpin);
  }
  private backSpinAccel() {
    return platterTaus.backSpinAccel(this._backSpin);
  }

  // --- state readers (Deck forwards these) ---

  get scrubbing() {
    return this.jogPhase !== "off";
  }
  /** True ONLY while the finger actively holds the platter (the "grab" phase) — distinct from
   *  `scrubbing`, which stays true through the release COAST and the Vinyl-Speed MOTOR ramps. A
   *  fresh scratch must (re-)grab whenever this is false even if `scrubbing` is true: `scrubMove`
   *  only applies in "grab", so otherwise the scratch is SWALLOWED while the platter coasts/ramps
   *  on its own (the jog-layer freeze). */
  get grabbing() {
    return this.jogPhase === "grab";
  }
  /** True while the platter is being dragged OR still coasting after release. */
  get jogging() {
    return this.jogPhase !== "off";
  }
  /** The in-flight motor ramp, if any — Deck's `get playing()` reads "start" as play intent. */
  get ramping() {
    return this._ramping;
  }
  /** The gripped platter's smoothed velocity in track-seconds per second (1 = play speed at
   *  rate 1). Read by the MIDI layer to decide when a physically free-spinning jog has settled
   *  enough to hand back to play (App/jogSpinFollow.ts). Meaningful only while grabbing. */
  get handVelocity() {
    return this.handVel;
  }
  /** Whether a release would spin back up to play (the deck was playing when gripped). */
  get returnsToPlay() {
    return this.jogReturnToPlay;
  }

  // --- scrubbing (jog-wheel / vinyl feel) ---
  //
  // The waveform drag is modelled as a weighted platter. While the finger is down
  // ("grab") the platter IS the finger (each pointer sample applied + voiced directly).
  // On release ("coast") the platter keeps its spin and either glides to rest under
  // friction (was paused) or eases back up to play speed like a motor catching it (was
  // playing). One worklet push per animation frame voices the slice the platter sweeps.

  scrubBegin() {
    if (!this.host.loaded()) return;
    // iOS starts the AudioContext suspended (its clock frozen) until a gesture resumes
    // it. The jog physics tick off ctx.currentTime, so without this a scrub before the
    // first Play sees dt≈0 every frame and the platter never moves.
    if (this.ctx.state === "suspended") void this.ctx.resume();
    this.host.clearBend(); // a grab takes over the clock — drop any decaying bend first
    this.host.slipArm(); // SLIP: anchor the shadow before the source stops (while still playing)
    this.jogReturnToPlay = this.host.playing() || (this.jogPhase === "coast" && this.jogReturnToPlay);
    // Gripping the platter STOPS IT DEAD (like a hand on vinyl) — it then follows the
    // finger from rest, so a scratch grab locks instantly with no forward creep. (The
    // turntable touch/brake feel lives on the PAUSE button, not the scratch grab.)
    this.jogPos = this.host.position();
    if (this.host.playing()) {
      this.host.setStartOffset(this.jogPos);
      this.host.stopSource();
      this.host.setPlaying(false);
    }
    this.handPos = this.handLast = this.jogPos;
    this.jogVel = 0;
    this._coastTau = 0;
    this._catchAccel = 0;
    this._ramping = null;
    this.handVel = 0;
    this.trail = [];
    this.trailPos = 0;
    this.trailTs = false;
    this.jogInputAt = this.ctx.currentTime;
    this.jogLast = this.ctx.currentTime;
    this.jogPhase = "grab";
    this.scratchStart();
    this.startJogLoop();
  }

  /** One (coalesced) pointer sample of finger motion, in track seconds. Applied straight
   *  to the platter and voiced on the worklet immediately — so scratch resolution tracks
   *  the mouse's true report rate (125–1000 Hz), not the display refresh. Position only:
   *  the release-fling VELOCITY is derived at frame rate in grabTick(). */
  scrubMove(deltaSec: number, ts?: number) {
    if (this.jogPhase !== "grab") return;
    this.jogInputAt = this.ctx.currentTime;
    let p = this.handPos + deltaSec;
    const dur = this.host.duration();
    if (p < 0) p = 0;
    else if (p > dur) p = dur;
    // A live loop is a closed ring while the platter will return to play: scrubbing
    // past OUT wraps to IN (and vice versa) instead of escaping into the rest of the
    // track — the industry-standard feel of spinning a loop edit on vinyl.
    if (this.jogReturnToPlay) p = this.wrapLoop(p);
    this.handPos = this.jogPos = p;
    this.host.setStartOffset(p);
    this.scratchMove(ts); // per-input-sample worklet push
    // The hand's own motion (unwrapped, unclamped), timed by the controller, for the release speed.
    this.trailTs = ts != null;
    if (ts != null) {
      this.trailPos += deltaSec;
      const H = this.trail;
      H.push(ts, this.trailPos);
      while (H.length > 512 || (H.length > 6 && ts - H[0] > 200)) H.splice(0, 2);
    }
  }

  /** The platter's speed at the moment of release (× realtime): the least-squares slope of the
   *  timestamped hand samples over the last FLING_WINDOW_MS (at least 3 samples within 100 ms), so a
   *  flick reads at the speed it actually reached, not at a frame-rate EMA that is still catching up.
   *  A hand that stopped before letting go cannot be faster than one step per the time since its last
   *  sample. null = no usable timestamped motion (pointer drags): the caller falls back to handVel. */
  releaseVelocity(now: number): number | null {
    const H = this.trail;
    if (!this.trailTs || H.length < 4) return null;
    const lastT = H[H.length - 2];
    // ★ DELIVERY STALLS. A fast-spinning FLX4's ticks stop arriving for 10-20 ms and then land as a
    // burst stamped with one time (all four backspins in the operator's capture do it), so a fit
    // across a stall reads the platter slower (the stall) or faster (the burst) than it turned. Fit
    // the latest unbroken RUN of ticks instead, or the one before a stall if the latest run is
    // still too short to fit; ticks after the stall prove the platter is still moving.
    const gaps: number[] = [];
    for (let i = H.length - 2; i >= 2 && gaps.length < 12 && lastT - H[i - 2] <= 100; i -= 2) gaps.push(H[i] - H[i - 2]);
    const med = gaps.length ? gaps.slice().sort((a, b) => a - b)[gaps.length >> 1] : 0;
    const stall = Math.max(5, 4 * med);
    const runStart = (end: number) => {
      let i = end;
      while (i >= 2 && H[i] - H[i - 2] <= stall && lastT - H[i - 2] <= 100) i -= 2;
      return i;
    };
    let end = H.length - 2;
    let start = runStart(end);
    if ((end - start) / 2 + 1 < 3 || H[end] - H[start] < 4) {
      if (start >= 2 && lastT - H[start - 2] <= 100) {
        end = start - 2;
        start = runStart(end);
      }
    }
    let i0 = end;
    while (i0 > start && H[end] - H[i0 - 2] <= JogEngine.FLING_WINDOW_MS) i0 -= 2;
    while ((end - i0) / 2 + 1 < 3 && i0 > start) i0 -= 2;
    const n = (end - i0) / 2 + 1;
    if (n < 2) return null;
    const t0 = H[end], x0 = H[end + 1];
    let st = 0, sp = 0, stt = 0, stp = 0;
    for (let i = i0; i <= end; i += 2) {
      const t = H[i] - t0, x = H[i + 1] - x0;
      st += t; sp += x; stt += t * t; stp += t * x;
    }
    const den = n * stt - st * st;
    let v = den > 1e-9 ? ((n * stp - st * sp) / den) * 1000 : 0;
    // A hand that stopped before letting go: no faster than its last step per the time since.
    // (Not before 16 ms, the stalls above.)
    const gap = (H[end] - H[i0]) / (n - 1);
    const since = now - lastT;
    if (since > 1.5 * gap && since > 16) {
      const step = Math.abs(H[H.length - 1] - H[H.length - 3]);
      const vMax = (step / since) * 1000;
      if (Math.abs(v) > vMax) v = Math.sign(v) * vMax;
    }
    return v;
  }

  /** Let go. `now` = when (performance.now() clock), for the timestamped release speed. */
  scrubEnd(now?: number) {
    if (this.jogPhase !== "grab") return;
    const tracked = this.releaseVelocity(now ?? performance.now());
    const action = decideRelease({
      handVel: tracked ?? this.handVel,
      jogReturnToPlay: this.jogReturnToPlay,
      slipPos: this.host.slipReleasePos(),
      backSpinAccel: this.backSpinAccel(),
      maxCoast: tracked != null ? JogEngine.MAX_COAST : JogEngine.POINTER_MAX_COAST,
      spinbackFlick: JogEngine.SPINBACK_FLICK,
      spinbackMaxBack: platterTaus.backSpinMaxBack(this._backSpin),
    });
    if (action.kind === "slip") {
      // The track kept advancing underneath — snap straight to that shadow playhead and
      // resume (no coast, no spinback), so the scratch was a non-destructive overlay and
      // the music lands back on-beat.
      this.jogPhase = "off";
      this._ramping = null;
      this._coastTau = 0;
      this.jogVel = 0;
      this.scratchStop();
      this.host.setStartOffset(action.pos);
      this.host.spawnSource(action.pos);
      this.host.setPlaying(true);
      return;
    }
    this.jogVel = action.vel;
    this._coastTau = 0;
    if (action.kind === "spinback") {
      this._catchAccel = action.accel;
      this._ramping = "spinback";
    } else {
      this._catchAccel = 0;
      this._ramping = null;
    }
    this._brakeZ = 0;
    this.jogLast = this.ctx.currentTime;
    this.jogPhase = "coast";
    this.startJogLoop();
  }

  // --- Vinyl Speed Adjust: transport motor ramps (brake / soft-start / spinback) ---
  // Each hands the audio to the scratch resampler and drives it through stepCoast at a
  // MOTOR time (not the jog weight/drag), so the playhead + pitch glide like a deck
  // powering down or up.

  /** Seed the coast from `initialVel`, heading either UP to play (resumePlay) or DOWN to
   *  a stop, over `tau`, voiced on the resampler. Shared by brake/softStart/spinback. */
  private enterMotorCoast(initialVel: number, resumePlay: boolean, tau: number, kind: "start" | "brake" | "spinback", accel = 0) {
    if (!this.host.loaded()) return;
    if (this.ctx.state === "suspended") void this.ctx.resume();
    this.host.clearBend();
    const wasPlaying = this.host.playing();
    this.jogPos = wasPlaying ? this.host.position() : this.host.startOffset();
    if (wasPlaying) {
      this.host.setStartOffset(this.jogPos);
      this.host.stopSource(); // hand the audio to the scratch resampler
      this.host.setPlaying(false);
    }
    this.jogReturnToPlay = resumePlay;
    this._coastTau = tau;
    this._ramping = kind;
    // The WORKLET owns the ramp now: it eases the read velocity from initialVel toward the
    // target at audio rate (smooth pitch glide), instead of us posting positions ~60x/s. A
    // brake settles at 0 (paused); spinback / soft-start ease up to the play rate and catch
    // back to normal playback. Cancel any in-flight platter rAF — the worklet drives this one.
    if (this.jogRaf) {
      if (typeof cancelAnimationFrame !== "undefined") cancelAnimationFrame(this.jogRaf);
      this.jogRaf = 0;
    }
    this.jogPhase = "motor";
    this.scratchStart(); // loads PCM (lazy on mobile) + raises the resampler gain
    // A ramp that TOUCHES a live loop stays confined to its ring — either headed back to
    // play (spinback catch / soft-start), or interrupting playback that was already inside
    // the loop (brake: it always fires from a playing deck, per brakeStop/brakeNow's own
    // guard — resumePlay=false there doesn't mean "wasn't playing"). Only a ramp starting
    // from an already-paused, freely-cued deck is left unconfined — needle-dropping around
    // the whole track, not the loop. (Found via the operator's report that brake/spinback
    // near a loop boundary felt structurally off — brake alone had been excluded from this
    // confinement, so pausing near the end of a loop could park the platter outside it.)
    const loop = wasPlaying || resumePlay ? this.host.loopBounds() : null;
    this.scratchNode?.port.postMessage({
      type: "ramp",
      vel: initialVel,
      target: resumePlay ? this.host.rate() : 0,
      tau,
      // A ramp headed back to play is a motor SERVO driving to target speed (servoStep); one
      // headed to a stop is a hand/pad FRICTION braking it (brakeFriction) — two different
      // physical processes, never the same curve. See the models above JogHost.
      servo: resumePlay,
      // accel > 0: a thrown record caught by the slipmat instead (motorStep, constant torque) — the
      // spinback. Soft-start keeps the servo: that is the motor spinning the whole platter up.
      accel,
      pos: this.jogPos * this.ctx.sampleRate,
      loopStart: loop ? loop.start * this.ctx.sampleRate : -1,
      loopEnd: loop ? loop.end * this.ctx.sampleRate : -1,
    });
  }

  /** Pause with a turntable power-down: decelerate the audio to a stop over the brake
   *  time, then settle paused. Falls back to instant pause() when Vinyl Speed is off. */
  brakeStop() {
    if (this._ramping === "brake") return;
    if (!this.host.playing() || !this._vinylSpeed || this._vinylBrake <= 0) {
      this.host.pause();
      return;
    }
    this.enterMotorCoast(this.host.effRate(), false, this.brakeTau(), "brake");
  }

  /** Release-FX brake: decelerate to a stop NOW regardless of the Vinyl Speed toggle (a
   *  one-shot transition trigger, not the play/pause feel). Uses the brake time if set,
   *  else a musical default. Playing decks only. */
  brakeNow() {
    if (!this.host.playing() || this.jogPhase === "reverse") return;
    this.enterMotorCoast(this.host.effRate(), false, this._vinylBrake > 0 ? this.brakeTau() : 0.3, "brake");
  }

  // ★ SLIP BRAKE (operator, 2026-11-07: "brake has to work like censor where it doesnt actually
  // pause the track"). The pad brake is a momentary OVERLAY, like CENSOR: held, the platter powers
  // down; released, playback snaps to where the track would be had it never braked (the slip
  // shadow, armed regardless of the slip toggle) and carries on. The board's RELEASE FX brake
  // (brakeNow) still stops the deck — that one is a stop.
  // ★ FX2 MOVES RUN ON THESE TWO PRIMITIVES; the Deck's move stack owns the rest (operator,
  // 2026-11-07: "gotta solve the interaction when one is held and another is triggered"). Start a
  // move's platter motion from `pos` — where the AUDIO is, which after a hand-off is wherever the
  // previous move left it, so the sound is continuous — and stop it again WITHOUT landing. Arming the
  // slip shadow, handing over between moves and landing on the beat are the Deck's (moveDown/moveUp).
  //   censor = reverse at the play rate · brake = a friction ramp to rest · spin = a backspin
  //   winding down to rest (the old spinback rewound and PLAYED ON from there, landing early).
  private _moveDriven = false;
  /** A scratch pattern in flight: offsets come from scratchOffset(kind, beats since the press, plus
   *  the beat phase it was pressed on), in track-seconds of `interval` per beat. */
  private pattern: { kind: ScratchKind; anchor: number; t0: number; beatReal: number; interval: number; phase0: number; base: number } | null = null;
  moveEnter(kind: "censor" | "brake" | "spin" | ScratchKind, pos: number, beat?: { interval: number; phase0: number }) {
    if (!this.host.loaded()) return;
    if (this.ctx.state === "suspended") void this.ctx.resume();
    this.host.clearBend();
    this.jogPos = pos;
    this.host.setStartOffset(pos);
    if (this.host.playing()) {
      this.host.stopSource(); // hand the audio to the scratch resampler
      this.host.setPlaying(false);
    }
    this._moveDriven = true;
    if (kind === "censor") {
      this.jogVel = 0;
      this.handVel = 0;
      this.jogInputAt = this.ctx.currentTime;
      this.jogLast = this.ctx.currentTime;
      this.jogPhase = "reverse";
      this.scratchStart();
      this.startJogLoop();
    } else if (kind === "brake") {
      this.enterMotorCoast(this.host.effRate(), false, this._vinylBrake > 0 ? this.brakeTau() : 0.3, "brake");
    } else if (kind === "spin") {
      this.enterMotorCoast(-this.backSpinStrength(), false, this.backSpinTau(), "spinback");
    } else {
      // A scratch pattern: phase-locked to the grid (it starts where the beat is, not at a fresh 0),
      // continuous at the press (the curve is taken relative to its value at that phase).
      const interval = beat?.interval ?? 0.5;
      const phase0 = beat?.phase0 ?? 0;
      this.pattern = { kind, anchor: pos, t0: this.ctx.currentTime, beatReal: interval / Math.max(0.05, this.host.rate()), interval, phase0, base: scratchOffset(kind, phase0) };
      this.jogVel = 0;
      this.handVel = 0;
      this.jogInputAt = this.ctx.currentTime;
      this.jogLast = this.ctx.currentTime;
      this.jogPhase = "pattern";
      this.scratchStart();
      this.startJogLoop();
    }
  }
  /** Stop a move's platter motion where it is, without landing. Returns where the audio got to. */
  moveExit(): number {
    this._moveDriven = false;
    this.pattern = null;
    if (this.jogRaf) {
      if (typeof cancelAnimationFrame !== "undefined") cancelAnimationFrame(this.jogRaf);
      this.jogRaf = 0;
    }
    this.jogPhase = "off";
    this._ramping = null;
    this._coastTau = 0;
    this.jogVel = 0;
    this.scratchStop();
    return this.jogPos;
  }

  /** Play with a turntable spin-up: ramp the audio from rest up to speed over the start
   *  time, then hand to normal playback. Falls back to instant play() when off. */
  softStart() {
    if (this.host.playing() || this._ramping === "start") return;
    if (!this.host.loaded() || !this._vinylSpeed || this._vinylStart <= 0) {
      this.host.play();
      return;
    }
    this.enterMotorCoast(0, true, this.startTau(), "start");
  }

  /** Spin the platter backward then let the motor catch it back to play — a triggerable
   *  back-spin (key / pad / FX), independent of a physical jog flick. */
  spinback(strength?: number) {
    if (!this.host.loaded()) return;
    const s = strength != null ? Math.abs(strength) : this.backSpinStrength();
    this.enterMotorCoast(-s, true, this.backSpinTau(), "spinback", this.backSpinAccel());
  }

  // --- sustained reverse / censor ---
  // Reverse routes through the SCRATCH resampler (signed motion → it plays backward
  // natively), so we never need the WSOLA stretch engine to run in reverse. The platter
  // is driven at −1× the set tempo; on stop we hand back to forward playback at either the
  // slip shadow (CENSOR, or REV with slip on) or the reversed-to position.
  get reversing() {
    return this.jogPhase === "reverse";
  }
  /** Engage sustained reverse (playing decks only). `forceSlip` arms the shadow regardless
   *  of the slip toggle (CENSOR always slip-returns); otherwise the slip toggle decides. */
  reverseStart(forceSlip: boolean) {
    if (!this.host.loaded() || !this.host.playing() || this.jogPhase === "reverse") return;
    if (this.ctx.state === "suspended") void this.ctx.resume();
    this.host.clearBend();
    if (forceSlip) this.host.slipArmForce();
    else this.host.slipArm();
    this.jogPos = this.host.position();
    this.host.setStartOffset(this.jogPos);
    this.host.stopSource(); // hand the audio to the scratch resampler
    this.host.setPlaying(false);
    this.jogVel = 0;
    this.handVel = 0;
    this.jogInputAt = this.ctx.currentTime;
    this.jogLast = this.ctx.currentTime;
    this.jogPhase = "reverse";
    this.scratchStart();
    this.startJogLoop();
  }
  /** Leave reverse: hand back to forward playback at the slip shadow (if armed) or the
   *  reversed-to position. */
  reverseStop() {
    if (this.jogPhase !== "reverse") return;
    this.jogPhase = "off";
    this.scratchStop();
    const slip = this.host.slipReleasePos();
    const pos = slip != null ? slip : this.jogPos;
    this.host.setStartOffset(pos);
    this.host.spawnSource(pos);
    this.host.setPlaying(true);
  }

  // --- the platter rAF loop ---

  private startJogLoop() {
    if (this.jogRaf || typeof requestAnimationFrame === "undefined") return;
    this.jogLast = this.ctx.currentTime;
    const tick = () => {
      this.jogRaf = 0;
      const phase = this.jogPhase;
      if (phase === "off") return;
      const now = this.ctx.currentTime;
      let dt = now - this.jogLast;
      this.jogLast = now;
      if (dt > 0) {
        dt = Math.min(dt, 0.05); // a tab-blur gap must not fling the platter
        if (phase === "grab") {
          this.grabTick(dt); // active motion posts in scrubMove(); this tracks fling + settles
        } else if (phase === "pattern" && this.pattern) {
          const pt = this.pattern;
          const beats = (now - pt.t0) / pt.beatReal + pt.phase0;
          this.jogPos = this.wrapLoop(pt.anchor + (scratchOffset(pt.kind, beats) - pt.base) * pt.interval);
          this.clampJog();
          this.host.setStartOffset(this.jogPos);
          this.scratchMove();
        } else if (phase === "reverse") {
          // Drive the platter backward at the set tempo; voice it on the resampler.
          // Reverse only ever runs on a playing deck (reverseStart requires it), so an
          // active loop always confines it — wrapping past IN to OUT and continuing,
          // instead of running out to the start of the whole track.
          this.jogPos = this.wrapLoop(this.jogPos - this.host.rate() * dt);
          this.clampJog();
          this.host.setStartOffset(this.jogPos);
          this.scratchMove();
          if (this.jogPos <= 0 && !this._moveDriven) this.reverseStop(); // hit the start → catch back to forward
        } else if (phase === "coast") {
          this.stepCoast(dt); // may settle the platter to "off"
          this.host.setStartOffset(this.jogPos);
          if (this.jogPhase !== "off") this.scratchMove(); // voice the coast motion
        }
      }
      if (this.jogPhase !== "off") this.jogRaf = requestAnimationFrame(tick);
    };
    this.jogRaf = requestAnimationFrame(tick);
  }

  // Abort an in-flight jog (drag or coast) WITHOUT moving the playhead — the current
  // platter position is already mirrored into startOffset each tick, so a transport
  // action (play/pause/seek/cue) simply takes over from where it is.
  cancelJog() {
    this._moveDriven = false; // a transport action ends any held FX2 move
    this.pattern = null;
    if (this.jogPhase === "off") return;
    this.jogPhase = "off";
    if (this.jogRaf) {
      if (typeof cancelAnimationFrame !== "undefined") cancelAnimationFrame(this.jogRaf);
      this.jogRaf = 0;
    }
    this.jogVel = 0;
    this.handVel = 0;
    this._ramping = null;
    this._coastTau = 0;
    this.scratchStop();
  }

  // Full reset on track load: cancel the jog, zero the platter. Scratch's PCM comes live
  // from the shared registry now (see the scratchNode field comment above), so there's
  // nothing to stale/re-send here — stretch's own loadPcm publishes the new track for it.
  reset() {
    this.cancelJog();
    this.jogPos = 0;
    this.handPos = 0;
    this.jogReturnToPlay = false;
  }

  // GRAB tick (frame rate): the platter IS the finger while gripped — each pointer sample
  // is applied + voiced directly in scrubMove() at full input rate (1:1, no spring lag,
  // sharp scratches). Here we only (a) track the release-fling velocity from the net hand
  // motion this frame, and (b) when the finger is HELD STILL / between input batches, feed
  // the worklet the held position so it settles to zero speed.
  private grabTick(dt: number) {
    const moved = this.handPos - this.handLast;
    this.handLast = this.handPos;
    const stale = this.ctx.currentTime - this.jogInputAt > 0.006;
    const inst = moved / dt;
    const hk = 1 - Math.exp(-dt / 0.03); // light smoothing → clean release-fling velocity
    this.handVel += (inst - this.handVel) * hk;
    this.jogVel = this.handVel;
    if (stale) {
      // no fresh input: settle the worklet to the held position (else it would drift)
      this.host.setStartOffset(this.jogPos);
      this.scratchMove();
    }
  }

  // COAST step: no finger. Either spin back up to play speed, or rub to a stop. A motor
  // ramp (brake / soft-start / spinback) is the same machinery with _coastTau set, so the
  // time comes from the Vinyl Speed knob instead of the jog weight/drag.
  private stepCoast(dt: number) {
    if (this.jogReturnToPlay) {
      // Released on a playing deck: the record slips on the still-turning platter and the slipmat's
      // constant friction brings it to play speed (motorStep, see above): linear, through zero for a
      // backspin, and locked exactly on the play rate. Trapezoidal position, so the platter travels
      // what the speed ramp says even at a 50 ms frame.
      const rate = this.host.rate();
      const accel = this._catchAccel > 0 ? this._catchAccel : platterTaus.catchAccel(this._jogWeight);
      const v0 = this.jogVel;
      this.jogVel = motorStep(v0, rate, dt, accel);
      this.jogPos = this.wrapLoop(this.jogPos + ((v0 + this.jogVel) / 2) * dt);
      this.clampJog();
      if (this.jogVel === rate) {
        // Hand the platter back to normal playback, continuing seamlessly: fade the
        // resampler out as the buffer source fades in (both declick).
        this.jogPhase = "off";
        this._ramping = null;
        this._coastTau = 0;
        this._catchAccel = 0;
        this.scratchStop();
        this.host.setStartOffset(this.jogPos);
        this.host.spawnSource(this.jogPos);
        this.host.setPlaying(true);
      }
    } else {
      // Friction glide / brake: drag sets the strength, or _coastTau the motor brake time.
      // A hand (or the jog pad) gripping the platter to a stop — brakeFriction, not a servo.
      const tau = this._coastTau > 0 ? this._coastTau : platterTaus.glide(this._jogWeight, this._jogDrag);
      const next = brakeFriction({ v: this.jogVel, z: this._brakeZ }, dt, tau);
      this.jogVel = next.v;
      this._brakeZ = next.z;
      this.jogPos += this.jogVel * dt;
      this.clampJog();
      if (Math.abs(this.jogVel) < 0.02) {
        this.jogPhase = "off";
        this._ramping = null;
        this._coastTau = 0;
        this._brakeZ = 0;
        this.jogVel = 0;
        this.host.setStartOffset(this.jogPos); // settle, paused, where it stopped
        this.scratchStop();
      }
    }
  }

  private clampJog() {
    const dur = this.host.duration();
    if (this.jogPos <= 0) {
      this.jogPos = 0;
      if (this.jogVel < 0) this.jogVel = 0;
    } else if (this.jogPos >= dur) {
      this.jogPos = dur;
      if (this.jogVel > 0) this.jogVel = 0;
    }
  }

  // Fold `p` into the active loop's ring — past OUT wraps to IN, past IN wraps to OUT —
  // so jog motion (scrub, coast, sustained reverse) that's headed back to play can never
  // escape a live loop, same as spinning a physical loop edit on vinyl. A no-op with no
  // active loop (or a degenerate one). Callers gate this on "will return to play" so it
  // mirrors position()'s own "the loop only wraps while playing" contract.
  private wrapLoop(p: number): number {
    const l = this.host.loopBounds();
    if (!l) return p;
    const len = l.end - l.start;
    if (!(len > 0)) return p;
    if (p >= l.end) return l.start + ((p - l.end) % len);
    if (p < l.start) return l.end - ((l.start - p) % len);
    return p;
  }
}
