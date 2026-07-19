// Delay — a DJ/dub delay modeled on the Waves H-Delay (character) + Arturia Delay
// Eternity (architecture). A STEREO feedback delay: two delay lines (L/R) each with a
// band-pass'd feedback path, switchable between independent (Single) and cross-fed
// (Ping-Pong) topologies, with selectable time-change behaviour and an infinite
// Freeze. Wet-mixed on top of the dry (BaseFxDevice).
//
//   input ─┬─→ dry ──────────────────────────────────────────────→ output
//          └→ split ┬→ preL → delayL → hpL → lpL ─┬→ merge L → wet → output
//                   │                  ▲          └→ fbL ┐
//                   └→ preR → delayR → hpR → lpR ─┬→ merge R → wet → output
//                                      ▲          └→ fbR ┐
//   Single:    fbL→delayL, fbR→delayR   Ping-Pong: fbL→delayR, fbR→delayL (cross)
//
// The HP→LP filters sit in the loop, so every repeat is re-filtered → the classic dub
// sweep / narrowing tails. `time` is beat-locked by the panel (division→seconds from the
// deck BPM). Tier 2 (analog/mod) and Tier 3 (ducking) splice into the marked points.
//
// Params: time · feedback · hp · lp · mix(base) + metadata sync/div/timeMode/stereo/link/freeze.

import { BaseFxDevice, type FxKind } from "./Fx";
import { clamp } from "../../util/math";
import { makeRectifyCurve, makeClampCurve } from "./duckingHelper";

export const DELAY_MAX_SECONDS = 2.0; // a whole bar at ≥120 BPM

// time-change behaviour (the H-Delay "variable pitch" vs Eternity Fade/Digital).
export const enum TimeMode {
  Repitch = 0, // glide the delay time → tape-style pitch slur on the tails (the DJ "throw")
  Digital = 1, // hard switch → clean retune, but can click while feedback rings
  Fade = 2, // dip the wet, switch, restore → no pitch, no click
}
export const enum StereoMode {
  Single = 0, // L/R independent (mono-ish if the input is mono)
  PingPong = 1, // feedback crosses L↔R → repeats bounce across the stereo field
}

const FB_MAX = 0.95; // normal feedback cap (always decays); Freeze overrides to ~1.0
const FREEZE_FB = 1.0;

export class DelayFx extends BaseFxDevice {
  readonly kind: FxKind = "delay";

  private readonly split: ChannelSplitterNode;
  private readonly merge: ChannelMergerNode;
  private readonly preL: GainNode; // input gain into each line (Freeze cuts these to 0)
  private readonly preR: GainNode;
  private readonly delayL: DelayNode;
  private readonly delayR: DelayNode;
  private readonly hpL: BiquadFilterNode;
  private readonly hpR: BiquadFilterNode;
  private readonly lpL: BiquadFilterNode;
  private readonly lpR: BiquadFilterNode;
  private readonly fbL: GainNode;
  private readonly fbR: GainNode;
  // Tier 2 — character: a waveshaper per side (analog drive) in the loop, and a shared
  // LFO modulating the delay times (vibrato/chorus tails).
  private readonly shaperL: WaveShaperNode;
  private readonly shaperR: WaveShaperNode;
  private readonly lfo: OscillatorNode;
  private readonly modL: GainNode; // LFO × depth → delayL.delayTime
  private readonly modR: GainNode;
  // Tier 3 — ducking: a pure-Web-Audio sidechain. The DRY input's envelope (rectify →
  // smooth → boost → clamp) is subtracted from a series gain on the wet, so loud input
  // pushes the echoes down and they bloom back in the gaps. No worklet, no main thread.
  private readonly rect: WaveShaperNode; // envelope rectifier (follower head — lazily wired)
  private readonly duckEnv: GainNode; // boosted envelope tap point
  private readonly duckScale: GainNode; // × −amount → seriesDuck.gain
  private readonly seriesDuck: GainNode; // intrinsic 1; envelope subtracts (stays ≥ 0)
  // ★ AudioParam.value CANNOT see audio-rate modulation delivered via .connect() — it only ever
  // reflects the param's own scheduled/intrinsic value. Proven: with duck=1 the WET signal
  // measures dead silent (the sidechain works perfectly) while seriesDuck.gain.value sits frozen
  // at 1 the entire time — not lagging, structurally blind. So the only legitimate way to read
  // this live is to tap the actual SIGNAL (an analyser, same pattern SatViz/CrushViz already use
  // for their own live reads) rather than the param it's driving.
  private readonly duckMeter: AnalyserNode;
  private readonly duckMeterBuf: Float32Array<ArrayBuffer>;
  private _duckWired = false; // follower in-circuit only while duck > 0
  private _duckGen = 0; // cancels a pending follower-unwire
  private _duckAmt = 0; // user's duck setting

  // metadata / state the panel reads back
  private _sync = 1; // 1 = beat-locked, 0 = free ms
  private _div = 2; // panel division index (default 1/8)
  private _timeMode: TimeMode = TimeMode.Repitch;
  private _stereo: StereoMode = StereoMode.Single;
  private _link = 0; // panel: move HP+LP together (band sweep)
  private _freeze = 0; // infinite hold (fb→1, input→0)
  private _fb = 0.38; // the user's feedback setting (Freeze temporarily overrides the live gain)
  private _analog = 0; // 0..1 tape/tube drive on the repeats
  private _spread = 0; // 0..1 — L/R delay-time offset (organic stereo width; Eternity "offset")
  // ★ COMMANDED-VALUE MIRRORS. Every continuous param here GLIDES — setTargetAtTime(…, 0.02) —
  // and setTargetAtTime is exponential: it asymptotically approaches its target and never exactly
  // arrives. So reading the getter off the live AudioParam (`delayTime.value`, `frequency.value`)
  // returns a value that is permanently CHASING what you asked for.
  //
  // That read-back is what a direct-manipulation surface renders from. Drag a tap: the viz
  // commands 0.5 s, reads back 0.28 mid-glide, and paints the tap back where it came from — the
  // surface appears to shove your hand away. The band sweep was worse: it multiplies hp and lp by
  // a ratio each frame, so it was COMPOUNDING on a lagging value and lurching.
  //
  // The audio still glides (that's the point — a stepped delay time clicks). The GETTERS just
  // report what was commanded. Same fix Eq3 already carries.
  private _targetTime = 0.375; // last requested delay time (so a SPREAD change re-applies it)
  private _hpHz = 120;
  private _lpHz = 6500;
  private _modDepth = 0;
  private _modRate = 0.5;

  constructor(ctx: AudioContext) {
    super(ctx, 0.28); // ~quarter wet by default

    this.split = ctx.createChannelSplitter(2);
    this.merge = ctx.createChannelMerger(2);
    this.preL = ctx.createGain();
    this.preR = ctx.createGain();
    this.delayL = ctx.createDelay(DELAY_MAX_SECONDS);
    this.delayR = ctx.createDelay(DELAY_MAX_SECONDS);
    this.delayL.delayTime.value = 0.375;
    this.delayR.delayTime.value = 0.375;

    // ★ For LOWPASS and HIGHPASS, Web Audio reads `Q` in DECIBELS — not as a linear Q factor.
    // (Spec: alpha = sin(w0) / (2 · 10^(Q/20)), unlike bandpass/peaking/notch where Q is linear.)
    // So Q = 0.7 is not Butterworth, it is 0.7 dB of RESONANCE: linear Q ≈ 1.08, a +1.7 dB peak at
    // the corner. Two of those sit INSIDE the feedback loop, where a peak IS a loop-gain multiplier
    // — which is why the true feedback overshot the knob at the top of its range (set 0.70 measured
    // 0.82; set 0.90 measured 1.054 and BUILT), FB_MAX = 0.95 was already unstable, and Freeze
    // (fb = 1.0) self-oscillated to +42 dB instead of holding. −3.01 dB IS Butterworth: 10^(−3.01/20)
    // = 0.7071. Same class of bug as the analog drive (a >1 gain hidden inside a feedback path).
    const FLAT_Q_DB = -3.01;
    const mkFilter = (type: BiquadFilterType, freq: number) => {
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = freq;
      f.Q.value = FLAT_Q_DB;
      return f;
    };
    this.hpL = mkFilter("highpass", 120);
    this.hpR = mkFilter("highpass", 120);
    this.lpL = mkFilter("lowpass", 6500);
    this.lpR = mkFilter("lowpass", 6500);
    this.fbL = ctx.createGain();
    this.fbR = ctx.createGain();
    this.fbL.gain.value = this._fb;
    this.fbR.gain.value = this._fb;

    this.shaperL = ctx.createWaveShaper();
    this.shaperR = ctx.createWaveShaper();
    this.shaperL.oversample = "2x";
    this.shaperR.oversample = "2x";
    // LFO → depth gain → delay times. Always running (cheap); depth 0 = no movement.
    this.lfo = ctx.createOscillator();
    this.lfo.type = "sine";
    this.lfo.frequency.value = 0.5;
    this.modL = ctx.createGain();
    this.modR = ctx.createGain();
    this.modL.gain.value = 0;
    this.modR.gain.value = 0;

    // input (stereo) → split → per-side pre-gain → delay. The split→pre wiring is set per
    // topology in rewire() (Single keeps L/R apart; Ping-Pong sums to one line).
    this.input.connect(this.split);
    this.preL.connect(this.delayL);
    this.preR.connect(this.delayR);
    // delay → HP → LP → color shaper (analog drive) → wet tap + feedback. The shaper sits
    // in the loop so the character compounds on each repeat (tape/old-sampler behaviour).
    this.delayL.connect(this.hpL);
    this.hpL.connect(this.lpL);
    this.lpL.connect(this.shaperL);
    this.delayR.connect(this.hpR);
    this.hpR.connect(this.lpR);
    this.lpR.connect(this.shaperR);
    // shaped repeat → wet (stereo merge: L tap → ch0, R tap → ch1) AND → feedback gain
    this.shaperL.connect(this.merge, 0, 0);
    this.shaperR.connect(this.merge, 0, 1);
    this.shaperL.connect(this.fbL);
    this.shaperR.connect(this.fbR);
    // ducking sidechain: dry input envelope → −amount → seriesDuck.gain (intrinsic 1). The
    // follower's HEAD (input→rect) and TAIL (duckScale→seriesDuck.gain) are wired lazily by
    // setDuck — at duck 0 it's severed at both ends so the engine prunes the whole follower
    // (the per-feature counterpart to the rack's activation gate; reverb's duck copies this).
    this.rect = ctx.createWaveShaper();
    this.rect.curve = makeRectifyCurve(); // |x|
    const smooth = ctx.createBiquadFilter();
    smooth.type = "lowpass";
    smooth.frequency.value = 12; // envelope smoothing
    this.duckEnv = ctx.createGain();
    this.duckEnv.gain.value = 4; // makeup so typical levels actually duck
    const clampShaper = ctx.createWaveShaper();
    clampShaper.curve = makeClampCurve(); // saturate the envelope to ≤ 1
    this.duckScale = ctx.createGain();
    this.duckScale.gain.value = 0; // −duck amount
    this.seriesDuck = ctx.createGain();
    this.seriesDuck.gain.value = 1;
    this.rect.connect(smooth);
    smooth.connect(this.duckEnv);
    this.duckEnv.connect(clampShaper);
    clampShaper.connect(this.duckScale);
    // wet sum routes THROUGH the duck gain on the way out (seriesDuck stays in the path; only
    // the follower feeding its gain is lazy). gain = 1 + (−env·amount) ∈ [1−amount, 1].
    this.merge.connect(this.seriesDuck);
    this.seriesDuck.connect(this.wet);
    // The live readback — tap duckScale's OWN output (already envelope × −amount, the exact
    // quantity that gets added to seriesDuck.gain) rather than trying to read the param it
    // drives. Tap only: this never feeds forward, so it costs nothing extra downstream.
    this.duckMeter = ctx.createAnalyser();
    this.duckMeter.fftSize = 256;
    this.duckMeter.smoothingTimeConstant = 0; // already smoothed upstream (the 12Hz follower)
    this.duckMeterBuf = new Float32Array(this.duckMeter.fftSize);
    this.duckScale.connect(this.duckMeter);
    // modulation: one LFO swings both delay times (added to the base time → vibrato).
    this.lfo.connect(this.modL);
    this.lfo.connect(this.modR);
    this.modL.connect(this.delayL.delayTime);
    this.modR.connect(this.delayR.delayTime);
    this.lfo.start();
    this.rewire(); // wire input routing + fbL/fbR → delays per the topology

    this.params.push(
      { id: "time", def: 0.375, get: () => this._targetTime, set: (v) => this.applyTime(clamp(v, 0.001, DELAY_MAX_SECONDS)) },
      { id: "feedback", def: 0.38, get: () => this._fb, set: (v) => this.setFeedback(clamp(v, 0, FB_MAX)) },
      { id: "hp", def: 120, get: () => this._hpHz, set: (v) => this.setFilterFreq("hp", clamp(v, 20, 18000)) },
      { id: "lp", def: 6500, get: () => this._lpHz, set: (v) => this.setFilterFreq("lp", clamp(v, 200, 18000)) },
      // metadata (persist + sync; the panel turns them into behaviour)
      { id: "sync", def: 1, get: () => this._sync, set: (v) => (this._sync = v ? 1 : 0) },
      { id: "div", def: 2, get: () => this._div, set: (v) => (this._div = Math.round(v)) },
      { id: "timeMode", def: 0, get: () => this._timeMode, set: (v) => (this._timeMode = clamp(Math.round(v), 0, 2)) },
      { id: "stereo", def: 0, get: () => this._stereo, set: (v) => this.setStereo(clamp(Math.round(v), 0, 1)) },
      { id: "link", def: 0, get: () => this._link, set: (v) => (this._link = v ? 1 : 0) },
      { id: "freeze", def: 0, get: () => this._freeze, set: (v) => this.setFreeze(v ? 1 : 0) },
      // Tier 2 — character
      { id: "analog", def: 0, get: () => this._analog, set: (v) => this.setColor(clamp(v, 0, 1)) },
      { id: "modDepth", def: 0, get: () => this._modDepth, set: (v) => this.setMod(clamp(v, 0, 0.012), undefined) },
      { id: "modRate", def: 0.5, get: () => this._modRate, set: (v) => this.setMod(undefined, clamp(v, 0.02, 8)) },
      // Tier 3 — ducking (repeats duck under the dry input)
      { id: "duck", def: 0, get: () => this._duckAmt, set: (v) => this.setDuck(clamp(v, 0, 1)) },
      { id: "spread", def: 0, get: () => this._spread, set: (v) => this.setSpread(clamp(v, 0, 1)) },
    );
  }

  // --- time + spread ---
  // SPREAD offsets the RIGHT line by up to +30 ms so L/R drift apart → organic stereo
  // width (a Haas-ish smear in Mono, a syncopated bounce in Ping-Pong). 0 = L≡R (tight).
  private applyTime(t: number) {
    this._targetTime = t;
    const now = this.ctx.currentTime;
    const tR = Math.min(DELAY_MAX_SECONDS, t + this._spread * 0.03);
    if (this._timeMode === TimeMode.Repitch) {
      // glide → the delay line resamples → pitch slur on the ringing tails
      this.delayL.delayTime.setTargetAtTime(t, now, 0.02);
      this.delayR.delayTime.setTargetAtTime(tR, now, 0.02);
    } else if (this._timeMode === TimeMode.Digital) {
      this.delayL.delayTime.setValueAtTime(t, now);
      this.delayR.delayTime.setValueAtTime(tR, now);
    } else {
      // Fade: dip the wet ~12 ms, switch instantly, restore — no pitch, no click.
      if (!this.isBypassed) {
        const m = this.mixAmount;
        const g = this.wet.gain;
        g.cancelScheduledValues(now);
        g.setValueAtTime(g.value, now);
        g.linearRampToValueAtTime(0, now + 0.012);
        this.delayL.delayTime.setValueAtTime(t, now + 0.013);
        this.delayR.delayTime.setValueAtTime(tR, now + 0.013);
        g.linearRampToValueAtTime(m, now + 0.026);
      } else {
        this.delayL.delayTime.setValueAtTime(t, now);
        this.delayR.delayTime.setValueAtTime(tR, now);
      }
    }
  }
  private setSpread(v: number) {
    this._spread = v;
    this.applyTime(this._targetTime); // re-apply so the R offset takes effect immediately
  }

  // --- ECHO OUT: the pad throw ------------------------------------------------------------
  // Press pushes the delay to a long, nearly-self-oscillating wet tail; RELEASE puts the user's
  // feedback/mix back so the CAPTURED repeats decay out on their own (that ring-out is the whole
  // point — pair it with a brake or a fader pull into silence). The base then returns the device
  // to dormant once the tail has had time to die, not the instant the pad comes up.
  private static readonly THROW_FB = 0.85; // FB_MAX is 0.95 — long tail, still decaying
  private _throwPrevFb: number | null = null;

  protected get hasTail() {
    return true; // the repeats need to ring out — see BaseFxDevice.hasTail
  }
  // A mostly-wet throw, same tasteful figure ReverbFx uses — a hair of dry stays audible even at
  // full send. The base class owns the snapshot/restore (see BaseFxDevice.throwMix); FEEDBACK is
  // the one thing left that's genuinely THIS device's own character to boost.
  protected get throwMix() {
    return 0.85;
  }
  // A manual bypass's ring-out (BaseFxDevice.muteWetInput) must stop NEW material reaching the
  // delay line, or whatever's still playing keeps re-triggering fresh echoes and the "tail" never
  // actually decays — it just keeps sounding like the effect never turned off. `split` is the
  // delay network's true entry point (see the constructor); cutting it here leaves whatever's
  // ALREADY in flight (echoes mid-feedback-loop) to ring out on their own, undisturbed.
  protected muteWetInput(muted: boolean) {
    if (muted) {
      try {
        this.input.disconnect(this.split);
      } catch {
        /* already disconnected */
      }
    } else {
      this.input.connect(this.split);
    }
  }
  protected applyThrowBoost(on: boolean) {
    if (on) {
      if (this._throwPrevFb == null) this._throwPrevFb = this._fb;
      this.setFeedback(DelayFx.THROW_FB);
    } else {
      const fb = this._throwPrevFb;
      this._throwPrevFb = null;
      if (fb != null) this.setFeedback(fb); // back to the user's setting → the captured repeats decay out
    }
  }

  // --- feedback / freeze ---
  private setFeedback(v: number) {
    this._fb = v;
    if (!this._freeze) {
      const now = this.ctx.currentTime;
      this.fbL.gain.setTargetAtTime(v, now, 0.01);
      this.fbR.gain.setTargetAtTime(v, now, 0.01);
    }
  }
  private setFreeze(on: number) {
    this._freeze = on;
    const now = this.ctx.currentTime;
    const fb = on ? FREEZE_FB : this._fb;
    const pre = on ? 0 : 1; // cut new input while frozen so it loops the captured tail
    this.fbL.gain.setTargetAtTime(fb, now, 0.02);
    this.fbR.gain.setTargetAtTime(fb, now, 0.02);
    this.preL.gain.setTargetAtTime(pre, now, 0.02);
    this.preR.gain.setTargetAtTime(pre, now, 0.02);
  }

  // --- character: analog drive (a shared waveshaper curve) ---
  private setColor(analog: number) {
    this._analog = analog;
    const curve = analog <= 0 ? null : makeColorCurve(analog);
    this.shaperL.curve = curve; // null = transparent pass-through (no extra CPU)
    this.shaperR.curve = curve;
  }

  // --- modulation: shared LFO swings both delay times (vibrato/chorus on the tails) ---
  private setMod(depth: number | undefined, rate: number | undefined) {
    const now = this.ctx.currentTime;
    if (depth != null) {
      this._modDepth = depth;
      this.modL.gain.setTargetAtTime(depth, now, 0.02);
      this.modR.gain.setTargetAtTime(depth, now, 0.02);
    }
    if (rate != null) {
      this._modRate = rate;
      this.lfo.frequency.setTargetAtTime(rate, now, 0.02);
    }
  }

  // --- ducking: the dry-input envelope pushes the repeats down. Lazily wired — the
  // follower (rectify → smooth → makeup → clamp → −amount) only exists in the graph while
  // duck > 0, so an un-ducked delay pays nothing for it. Severing BOTH ends lets the audio
  // thread prune the chain (its tail feeds an active node's gain param, so a head-only cut
  // wouldn't be enough). ---
  private setDuck(amt: number) {
    this._duckAmt = amt;
    const now = this.ctx.currentTime;
    if (amt > 0 && !this._duckWired) {
      this._duckGen++; // cancel any pending unwire
      this.input.connect(this.rect); // follower head
      this.duckScale.connect(this.seriesDuck.gain); // follower tail (subtracts from unity)
      this._duckWired = true;
    }
    this.duckScale.gain.setTargetAtTime(-amt, now, 0.02);
    if (amt <= 0 && this._duckWired) {
      const gen = ++this._duckGen;
      // let the envelope settle (seriesDuck.gain back to ~1) before pruning the follower.
      setTimeout(() => {
        if (gen !== this._duckGen || !this._duckWired) return;
        try {
          this.input.disconnect(this.rect);
        } catch {
          /* already gone */
        }
        try {
          this.duckScale.disconnect(this.seriesDuck.gain);
        } catch {
          /* already gone */
        }
        this._duckWired = false;
      }, 120);
    }
  }

  // ★ Reads a SIGNAL, not a param — see duckMeter's own comment. seriesDuck.gain.value is
  // permanently frozen at its intrinsic 1 no matter what the sidechain is actually doing,
  // because that modulation arrives via .connect(), which .value structurally cannot see.
  // Proven with an isolated instance + a real oscillator: full duck (1.0) measured on the wet
  // signal is dead silent — the DSP is correct — while .value read 1 the entire time. duckScale's
  // OWN output is already envelope×−amount, so its most-negative recent sample IS 1−duckGain.
  get duckGain(): number {
    this.duckMeter.getFloatTimeDomainData(this.duckMeterBuf);
    let min = 0; // duckScale's output is always ≤ 0
    for (const v of this.duckMeterBuf) if (v < min) min = v;
    return clamp(1 + min, 0, 1);
  }

  // --- filters ---
  private setFilterFreq(which: "hp" | "lp", hz: number) {
    const now = this.ctx.currentTime;
    if (which === "hp") this._hpHz = hz;
    else this._lpHz = hz;
    if (which === "hp") {
      this.hpL.frequency.setTargetAtTime(hz, now, 0.02);
      this.hpR.frequency.setTargetAtTime(hz, now, 0.02);
    } else {
      this.lpL.frequency.setTargetAtTime(hz, now, 0.02);
      this.lpR.frequency.setTargetAtTime(hz, now, 0.02);
    }
  }

  // --- stereo topology ---
  private setStereo(mode: StereoMode) {
    if (mode === this._stereo) return;
    this._stereo = mode;
    this.rewire();
  }
  // Wire BOTH the input routing and the feedback routing for the current topology.
  //   Single:    L→delayL, R→delayR + straight feedback → stereo preserved, two independent taps.
  //   Ping-Pong: input SUMMED into the left line only + CROSSED feedback (L's repeat feeds delayR,
  //              R's feeds delayL) → the echo lands hard-left, then hard-right, then left… bouncing.
  //              (Summing to one line is the fix: feeding both lines at once made the first repeat
  //              centred, which sounded mono.)
  private rewire() {
    for (const n of [this.split, this.fbL, this.fbR]) {
      try {
        n.disconnect();
      } catch {
        /* nothing connected yet */
      }
    }
    if (this._stereo === StereoMode.PingPong) {
      this.split.connect(this.preL, 0); // L+R → preL (mono sum into the left line)
      this.split.connect(this.preL, 1);
      this.fbL.connect(this.delayR); // cross-feed → repeats bounce L↔R
      this.fbR.connect(this.delayL);
    } else {
      this.split.connect(this.preL, 0);
      this.split.connect(this.preR, 1);
      this.fbL.connect(this.delayL);
      this.fbR.connect(this.delayR);
    }
  }
}

// Waveshaper transfer curve for analog DRIVE — tanh soft-clip, level-matched so unity stays
// ~unity. Caller passes null instead when drive is off (transparent). 2048 points is plenty.
function makeColorCurve(analog: number): Float32Array<ArrayBuffer> {
  const n = 2048;
  const curve = new Float32Array(n);
  // UNITY small-signal gain (slope at x=0 is exactly 1) so the drive is NON-EXPANSIVE. This shaper
  // sits INSIDE the feedback loop, so its slope near zero IS a loop-gain multiplier: the old
  // peak-normalized tanh (÷tanh(k), slope k/tanh(k) ≈ k > 1) amplified the decaying tail back up
  // → loop gain fb·slope ≥ 1 → the delay self-oscillated and never decayed (measured: analog>0
  // presets rang at effective feedback 1.0). tanh(kx)/k passes quiet tails at unity (they decay at
  // fb) and only saturates loud transients — the tape/tube warmth without the runaway.
  const k = 1 + analog * 2.5; // gentler drive; the character still compounds over repeats
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1; // −1..1
    curve[i] = Math.tanh(k * x) / k;
  }
  return curve;
}
