import { lerp } from "../../util/math";
import { isMobileDevice } from "../stems/models";

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
  scratchBuffer(): AudioBuffer | null; // decoded PCM for the resampler (lazy on mobile)
  connectScratch(node: AudioWorkletNode): void; // node.connect(deck channel input)
  slipArm(): void; // SLIP: anchor the shadow playhead at grab (no-op unless slip on + playing)
  slipArmForce(): void; // CENSOR: anchor the shadow regardless of the slip toggle (still playing-only)
  slipReleasePos(): number | null; // SLIP: where the track would be now, or null (no anchor)
}

// rekordbox-style jog / platter physics: the scratch resampler driver + the weighted-
// platter grab/coast + the Vinyl Speed Adjust motor ramps (brake / soft-start / spinback).
// Extracted from Deck so the scratch surface is debuggable on its own; behaviour is 1:1.
export class JogEngine {
  private static readonly MAX_COAST = 3; // cap on release speed (× realtime)
  private static readonly SPINBACK_FLICK = 2.2; // release speed (× realtime) past which a BACKWARD jog flick = a spinback

  private jogPhase: "off" | "grab" | "coast" | "reverse" | "motor" = "off"; // "motor" = a worklet-owned brake/spinback/soft-start ramp
  private jogPos = 0; // platter position (track sec) — authoritative while jogging
  private jogVel = 0; // sounding velocity (track-sec / real-sec, signed)
  private handPos = 0; // where the finger says the platter is (accumulated)
  private handLast = 0; // handPos at the previous frame tick (for frame-rate fling velocity)
  private handVel = 0; // smoothed finger velocity, drives pitch + release fling
  private jogInputAt = 0; // ctx time of the last pointer sample (for per-input motion)
  private jogLast = 0; // ctx time of the last tick
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

  // The continuous scrub resampler (attached by AudioEngine), owned here.
  private scratchNode: AudioWorkletNode | null = null;
  private scratchLoaded = false; // the worklet holds this track's PCM (mobile loads it lazily)

  constructor(private readonly ctx: AudioContext, private readonly host: JogHost) {}

  // --- scratch resampler wiring ---

  /** Wire the scratch resampler in parallel with the source, into the EQ (raw pitch,
   *  bypassing key-lock — scrubbing should pitch like vinyl). */
  attachNode(node: AudioWorkletNode) {
    this.host.connectScratch(node);
    this.scratchNode = node;
    node.port.onmessage = (e) => this.onScratchMessage(e.data); // worklet-ramp position + done
    if (this.host.scratchBuffer() && !isMobileDevice()) this.sendBuffer();
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

  // Hand the whole decoded track to the resampler (its own copies, so the AudioBuffer's
  // backing store isn't detached by the transfer). A FULL float32 duplicate per deck —
  // desktop preloads it eagerly, mobile lazily on first scratch (the two-deck iOS peak).
  sendBuffer() {
    const b = this.host.scratchBuffer();
    if (!this.scratchNode || !b) return;
    const channels: Float32Array[] = [];
    const transfer: ArrayBuffer[] = [];
    for (let c = 0; c < b.numberOfChannels; c++) {
      const copy = b.getChannelData(c).slice();
      channels.push(copy);
      transfer.push(copy.buffer);
    }
    this.scratchNode.port.postMessage({ type: "load", channels, length: b.length }, transfer);
    this.scratchLoaded = true;
  }
  private scratchStart() {
    if (!this.scratchLoaded) this.sendBuffer(); // mobile: lazy-load the PCM on first scratch
    this.scratchNode?.port.postMessage({ type: "start", pos: this.jogPos * this.ctx.sampleRate });
  }
  private scratchMove() {
    // Position only — the worklet reconstructs smooth motion from the position stream
    // itself; feeding it our noisy per-frame velocity made it garbled.
    this.scratchNode?.port.postMessage({ type: "move", pos: this.jogPos * this.ctx.sampleRate });
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
    return lerp(0.02, 0.5, this._vinylBrake);
  }
  private startTau() {
    return lerp(0.02, 0.45, this._vinylStart);
  }
  private backSpinTau() {
    return lerp(0.12, 0.6, this._backSpin);
  }
  private backSpinStrength() {
    return lerp(4, 14, this._backSpin);
  }

  // --- state readers (Deck forwards these) ---

  get scrubbing() {
    return this.jogPhase !== "off";
  }
  /** True while the platter is being dragged OR still coasting after release. */
  get jogging() {
    return this.jogPhase !== "off";
  }
  /** The in-flight motor ramp, if any — Deck's `get playing()` reads "start" as play intent. */
  get ramping() {
    return this._ramping;
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
    this._ramping = null;
    this.handVel = 0;
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
  scrubMove(deltaSec: number) {
    if (this.jogPhase !== "grab") return;
    this.jogInputAt = this.ctx.currentTime;
    let p = this.handPos + deltaSec;
    const dur = this.host.duration();
    if (p < 0) p = 0;
    else if (p > dur) p = dur;
    this.handPos = this.jogPos = p;
    this.host.setStartOffset(p);
    this.scratchMove(); // per-input-sample worklet push
  }

  scrubEnd() {
    if (this.jogPhase !== "grab") return;
    // SLIP: if armed, the track kept advancing underneath — snap straight to that shadow
    // playhead and resume (no coast, no spinback), so the scratch was a non-destructive
    // overlay and the music lands back on-beat.
    const slipPos = this.host.slipReleasePos();
    if (slipPos != null) {
      this.jogPhase = "off";
      this._ramping = null;
      this._coastTau = 0;
      this.jogVel = 0;
      this.scratchStop();
      this.host.setStartOffset(slipPos);
      this.host.spawnSource(slipPos);
      this.host.setPlaying(true);
      return;
    }
    // Motion was applied per input sample in scrubMove(); just hand the platter its
    // release spin — the finger's last smoothed velocity, capped so a violent flick
    // can't launch it across the whole track.
    const max = JogEngine.MAX_COAST;
    this.jogVel = Math.max(-max, Math.min(max, this.handVel));
    // The FLX4 (and Pioneer gear in general) has no dedicated spinback button — the
    // native gesture is a hard BACKWARD flick of the jog. When the release is a strong
    // back-fling during playback, give it the dramatic, tunable back-spin-and-catch curve
    // (backSpinTau) instead of the quick jog-physics coast. Always available (it's a
    // gesture, not the motor brake). Otherwise reset _coastTau so a normal release uses
    // the jog weight/drag.
    if (this.jogReturnToPlay && this.jogVel < -JogEngine.SPINBACK_FLICK) {
      this._coastTau = this.backSpinTau();
      this._ramping = "spinback";
    } else {
      this._coastTau = 0;
      this._ramping = null;
    }
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
  private enterMotorCoast(initialVel: number, resumePlay: boolean, tau: number, kind: "start" | "brake" | "spinback") {
    if (!this.host.loaded()) return;
    if (this.ctx.state === "suspended") void this.ctx.resume();
    this.host.clearBend();
    this.jogPos = this.host.playing() ? this.host.position() : this.host.startOffset();
    if (this.host.playing()) {
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
    this.scratchNode?.port.postMessage({
      type: "ramp",
      vel: initialVel,
      target: resumePlay ? this.host.rate() : 0,
      tau,
      pos: this.jogPos * this.ctx.sampleRate,
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
    this.enterMotorCoast(-s, true, this.backSpinTau(), "spinback");
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
        } else if (phase === "reverse") {
          // Drive the platter backward at the set tempo; voice it on the resampler.
          this.jogPos -= this.host.rate() * dt;
          this.clampJog();
          this.host.setStartOffset(this.jogPos);
          this.scratchMove();
          if (this.jogPos <= 0) this.reverseStop(); // hit the start → catch back to forward
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

  // Full reset on track load: cancel the jog, zero the platter, and stale the worklet PCM
  // (desktop re-sends via sendBuffer() after the new buffer is set; mobile lazy-loads).
  reset() {
    this.cancelJog();
    this.jogPos = 0;
    this.handPos = 0;
    this.jogReturnToPlay = false;
    this.scratchLoaded = false;
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
      // Catch back up to play speed (jog release, soft-start, or a spinback's recovery):
      // glide the rate toward 1× locally, then hand back to normal playback.
      const rate = this.host.rate();
      const tau = this._coastTau > 0 ? this._coastTau : lerp(0.025, 0.12, this._jogWeight);
      this.jogVel += (rate - this.jogVel) * (1 - Math.exp(-dt / tau));
      this.jogPos += this.jogVel * dt;
      this.clampJog();
      if (Math.abs(this.jogVel - rate) < 0.03) {
        // Hand the platter back to normal playback, continuing seamlessly: fade the
        // resampler out as the buffer source fades in (both declick).
        this.jogPhase = "off";
        this._ramping = null;
        this._coastTau = 0;
        this.scratchStop();
        this.host.setStartOffset(this.jogPos);
        this.host.spawnSource(this.jogPos);
        this.host.setPlaying(true);
      }
    } else {
      // Friction glide / brake: drag sets the strength, or _coastTau the motor brake time.
      // Kept short (sub-second) so a flick eases off instead of spinning away.
      const tau = this._coastTau > 0 ? this._coastTau : lerp(0.6, 0.1, this._jogDrag) * lerp(0.7, 1.3, this._jogWeight);
      this.jogVel *= Math.exp(-dt / tau);
      this.jogPos += this.jogVel * dt;
      this.clampJog();
      if (Math.abs(this.jogVel) < 0.02) {
        this.jogPhase = "off";
        this._ramping = null;
        this._coastTau = 0;
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
}
