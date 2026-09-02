// AudioWorklet source for the jog/scratch sound — the single continuous resampler
// that every real turntable emulator (Mixxx, Serato, …) uses:
//
//   • ONE moving read pointer (`pos`, a fractional sample index) walks the whole
//     track. No per-frame grains → no boundary clicks, no zipper noise.
//   • It's driven by POSITION only: the deck sends the platter position ~60×/s and
//     the worklet reconstructs smooth motion by linearly connecting consecutive
//     positions over the MEASURED interval between them. No noisy hand-velocity in
//     the audio loop — that's what turned scratches into garbled fast-forward.
//   • Signed motion → reverse and crossing zero are the same code path; no reversed
//     buffer copy.
//   • 4-point cubic (Catmull-Rom) interpolation reads between samples cleanly
//     (linear dulls/aliases under the fast-changing scratch rate).
//   • A velocity-dependent lowpass anti-aliases the speed-up case (reading faster
//     than 1× is decimation, which would otherwise fold highs back as metallic
//     grunge); below 1× it opens fully and keeps all the highs.
//   • Reads PCM live out of a registry shared with the stretch (playback) worklet —
//     see the module-scope note below — instead of holding its own copy, so a scratch
//     is never more than a live view onto whatever stretch already has resident.
//
// Loaded via a Blob URL so it's bundler-agnostic (see AudioEngine).
export const SCRATCH_WORKLET_SRC = `
// Both this module and stretchWorklet.ts load into the SAME AudioWorkletGlobalScope
// (one global scope per BaseAudioContext — separate addModule() calls on the same
// context share it), so a module-scope registry keyed by deck id lets this processor
// read the stretch worklet's already-resident PCM directly, with zero extra copies and
// no message round-trip. Idempotent regardless of which module's addModule() lands
// first. Replaces the old per-worklet PCM transfer + the mobile windowed-PCM-extraction
// machinery entirely (see stretchWorklet.ts's loadPcm handler, the writer side).
if (!globalThis.__htlPcm) globalThis.__htlPcm = new Map();

// One render quantum. Below this an update carries a newer position but no usable timing — the
// worklet has not run in between, so nothing has actually elapsed that we could measure against.
const MIN_INTERVAL = 128;
class Scratch extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.deckId = (options && options.processorOptions && options.processorOptions.deckId) || 'A';
    this.pcm = null;     // this deck's { gL, gR, length, pcmScale } — refreshed once per block
    this.pos = 0;        // fractional read pointer (samples)
    this.target = 0;     // latest platter position from the UI (samples)
    this.step = 0;       // per-sample velocity for the current segment (samples)
    this.curStep = 0;    // lightly smoothed step → clean pitch across segments
    this.since = 0;      // output samples since the last 'move' (measures cadence)
    this.interval = 0;   // samples between the last two 'move's (segment length)
    this.accDt = 0;      // wall-clock banked since the last re-pace (see the 'move' handler)
    this.repace = false; // did this update carry enough elapsed time to recompute the step?
    this.active = false;
    this.gain = 0;       // declick envelope
    this.gainTarget = 0;
    this.lp = [[0, 0], [0, 0]]; // anti-alias lowpass state (2 stages × 2 channels)
    this.lpA = 1;        // current lowpass coefficient (1 = open / no filtering)
    this.nominal = Math.round(sampleRate / 60); // expected samples per UI frame
    this.kStep = 1 - Math.exp(-1 / (0.005 * sampleRate)); // ~5 ms pitch smoothing
    this.kGain = 1 - Math.exp(-1 / (0.004 * sampleRate)); // ~4 ms declick
    // GRANULAR fast-scrub: a continuous resampler can only walk through every sample,
    // so a fast/zoomed-out drag (the finger covering minutes of audio) rate-limits to
    // a multi-second 32× "spin" that LAGS the finger. The fix every pro scrubber uses:
    // once the finger outruns continuous playback, the playhead TRACKS THE FINGER with
    // no lag (uncapped) and we voice short ~1×-pitch Hann grains at the live position —
    // overlap-added two at a time — so you hear the song's sections fly past locked to
    // your hand (Pro Tools scrub / Serato needle-search / granular synthesis, grains
    // ~10–50 ms). Slow/medium scrubbing stays the crisp continuous resampler below.
    this.granular = false;
    this.glen = Math.round(sampleRate * 0.045); this.glen -= this.glen % 2; // ~45 ms grain
    this.gh = this.glen >> 1; // 50% hop/overlap
    this.gwin = new Float32Array(this.glen);
    for (let i = 0; i < this.glen; i++) this.gwin[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / this.glen);
    this.phaseA = 0; this.startA = 0; this.startB = 0; // two staggered grain heads
    this.stepRaw = 0; this.curRaw = 0; // uncapped finger-tracking velocity
    // Per-stem-group live gain (mute/level knob), same 'stemGain' message + index convention
    // as stretchWorklet's own this.gain_ — kept independently rather than read off the shared
    // PCM registry entry, since the registry only carries the PCM itself, not live mixer state.
    // Defaults to unity (not stretchWorklet's post-load 0-for-unused-slots reset, which scratch
    // has no equivalent load event to hook) — readCh only ever sums up to groups.length anyway,
    // so an untouched slot beyond the real group count is simply never read.
    this.gain_ = new Float32Array([1, 1, 1, 1]);
    // Worklet-OWNED motor ramp (brake / spinback / soft-start): the read velocity glides
    // exponentially toward a target at AUDIO rate instead of being re-posted as positions
    // ~60x/s. That kills the stair-step on the pitch glide (Mixxx drives its scratch at a
    // 1 kHz timer; here it's per output sample). Reports position back for the visual playhead.
    this.ramping = false; this.rampTarget = 0; this.rampTau = 0.1; this.rampSince = 0;
    this.rampLoopStart = -1; this.rampLoopEnd = -1; // -1,-1 = no active loop (ramp runs to the track edge)
    this.rampServo = true; this.rampA = 0; this.rampZ = 0; // servoStep / brakeFriction state
    this.port.onmessage = (e) => {
      const d = e.data;
      if (d.type === 'start') {
        // A grab mid-motor-curve (brake/spinback/soft-start) must cancel the ramp, or the
        // audio-rate physics kept running underneath the new grab until IT converged on its
        // own — process()'s ramping branch (it early-continues per sample) runs before any
        // of the code below ever gets to read the fresh pos/step this message just set. The
        // JS side (JogEngine.scrubBegin/onScratchMessage) already re-grabs unconditionally; this was
        // the one place the worklet didn't follow.
        this.ramping = false;
        this.pos = this.target = d.pos;
        this.step = this.curStep = 0;
        this.granular = false; this.curRaw = 0; // a fresh grab always starts continuous
        this.since = 0;
        this.interval = this.nominal;
        this.accDt = 0; // a fresh grab must not inherit the previous gesture's cadence
        this.repace = false;
        this.lp[0][0] = this.lp[0][1] = this.lp[1][0] = this.lp[1][1] = 0;
        this.lpA = 1;
        this.active = true;
        this.gainTarget = 1;
      } else if (d.type === 'move') {
        // Set the velocity that walks the pointer from where it actually is to the
        // new platter position over ~one update interval. Using the real elapsed
        // interval (not a guess) keeps the motion smooth and drift-free; computing
        // it from the POSITION delta (not the sent velocity) removes the jitter.
        //
        // ★ COALESCE, DON'T SMOOTH. The interval paces the chase from where the read head IS to
        // the new platter position, so it has to be the real time between updates.
        //
        // Two ways to get that wrong, and this code has had both. Using the worklet's own "since"
        // counter fails on BURSTY input: it only advances during process(), so several updates
        // delivered inside one ~2.9ms render quantum all read since=0 and fall back to a fixed
        // ~16.7ms guess — ~4x too slow (measured on a real DDJ-FLX4 capture, where a third of
        // consecutive jog ticks land in the same quantum). Reading too slow drags the pitch down
        // and pins the smoothing tau at its slowest.
        //
        // Replacing it with an EMA of the caller's wall-clock gap fixed the hardware jog and broke
        // the pointer. Mouse and touch also burst — the browser can deliver several pointermoves
        // in one frame — and there the EMA pulls the interval DOWN toward those sub-millisecond
        // gaps while the position delta is still a whole frame's worth. Dividing a full delta by a
        // fraction of its time reads too FAST. So the estimate now oscillates around the truth
        // instead of sitting under it: same wrong-velocity fault, opposite sign, which is why the
        // scratch changed character on mouse AND touch rather than going quiet.
        //
        // The fix is neither. Sub-quantum updates carry no new TIMING information, only a newer
        // position — so take the position and bank the time, and recompute the step only once a
        // real interval has actually elapsed. Numerator and denominator then always describe the
        // same stretch of wall clock, which is the property both broken versions gave up.
        {
          const dtSamples = d.dtMs > 0 ? (d.dtMs * sampleRate) / 1000 : 0;
          this.accDt += dtSamples > 0 ? dtSamples : (this.since > 0 ? this.since : 0);
          if (this.accDt >= MIN_INTERVAL || this.interval <= 0) {
            this.interval = Math.max(1, this.accDt > 0 ? this.accDt : this.nominal);
            this.accDt = 0;
            this.repace = true;
          } else {
            this.repace = false; // same quantum: newer target, same pacing
          }
        }
        this.since = 0;
        this.target = d.pos;
        // A sub-quantum update moves the TARGET (the chase always aims at the latest position)
        // but leaves the pacing alone — there is no new timing to pace with yet.
        if (!this.repace) return; // keep the current step; the next re-pace will use the banked time
        this.stepRaw = (this.target - this.pos) / this.interval; // uncapped (granular tracks the finger)
        let s = this.stepRaw;
        if (s > 32) s = 32; else if (s < -32) s = -32; // continuous resampler clamp
        this.step = s;
        // Switch to granular when the finger outruns continuous playback (hysteresis
        // so it doesn't flutter at the boundary). Below ~8× a hand move still sounds
        // like vinyl; above it the continuous pointer would lag into a multi-second spin.
        const reqSpeed = this.stepRaw < 0 ? -this.stepRaw : this.stepRaw;
        if (!this.granular && reqSpeed > 8) {
          this.granular = true;
          this.phaseA = 0; this.startA = this.pos; this.startB = this.pos; this.curRaw = this.stepRaw;
        } else if (this.granular && reqSpeed < 5) {
          this.granular = false; this.curStep = 0;
        }
        // Adapt the pitch-smoothing time constant to the ACTUAL update interval:
        // dense (high-rate, per-input) updates need almost no smoothing → snappy;
        // sparse ~60 Hz updates need more to bridge the gap without a stair-step.
        // Clamp 1…8 ms. (Updates now arrive at the mouse's full report rate.)
        const tau = Math.min(0.008, Math.max(0.001, (this.interval / sampleRate) * 0.6));
        this.kStep = 1 - Math.exp(-1 / (tau * sampleRate));
      } else if (d.type === 'ramp') {
        // Begin an audio-rate motor ramp. vel = initial read velocity (samples/output-sample,
        // i.e. playback rate: 1 = forward 1x, -8 = 8x reverse), target = where it eases to
        // (0 = stop, the play rate = catch back to play), tau = exp time constant (seconds).
        this.pos = d.pos;
        this.curStep = d.vel;
        this.rampTarget = d.target;
        this.rampTau = Math.max(0.001, d.tau);
        this.rampServo = d.servo; // true = motor servo (spinback/soft-start), false = friction brake
        this.rampA = 0; this.rampZ = 0; // fresh state per ramp — see servoStep/brakeFriction in JogEngine.ts
        this.ramping = true; this.granular = false; this.rampSince = 0;
        this.active = true; this.gainTarget = 1;
        // loopStart/loopEnd (worklet-local samples), or -1,-1 when the deck has no active
        // loop — a spinback/soft-start ramp that's headed back to play stays inside a live
        // loop instead of throwing the platter out past its edge.
        this.rampLoopStart = d.loopStart; this.rampLoopEnd = d.loopEnd;
      } else if (d.type === 'stop') {
        this.gainTarget = 0; // fade out; go fully idle once silent
        this.ramping = false; // a transport takeover cancels an in-flight ramp
      } else if (d.type === 'stemGain') {
        if (d.index >= 0 && d.index < 4) this.gain_[d.index] = d.value;
      }
    };
  }
  // One sample of one output channel (0=L, 1=R) from the shared PCM registry, weighted by
  // this.gain_ per group — the same live per-stem mute/level state stretchWorklet's own
  // playback already reflects (Deck.rampStem posts the identical 'stemGain' message to both
  // nodes now). Used to be an unweighted sum regardless of mute state; that was never a
  // deliberate choice, just nothing had wired the mixer's live gain into scratch's read path.
  // Clamps to the track edges (repeats the edge sample) rather than zero-padding — granular
  // grains can read past either end. Silence (not a crash) when nothing's registered yet.
  readCh(ch, idx) {
    const pcm = this.pcm;
    if (!pcm || pcm.length === 0) return 0;
    const n = pcm.length;
    if (idx < 0) idx = 0; else if (idx > n - 1) idx = n - 1;
    const groups = ch === 0 ? pcm.gL : pcm.gR;
    let s = 0;
    for (let g = 0; g < groups.length; g++) { const ga = this.gain_[g]; if (ga) s += ga * groups[g][idx]; }
    return s * pcm.pcmScale;
  }
  cubic(ch, pos) {
    const i = Math.floor(pos);
    const x = pos - i;
    const s1 = this.readCh(ch, i - 1), s2 = this.readCh(ch, i), s3 = this.readCh(ch, i + 1), s4 = this.readCh(ch, i + 2);
    const c1 = x * (-0.5 + x * (1 - 0.5 * x));
    const c2 = 1 + x * x * (1.5 * x - 2.5);
    const c3 = x * (0.5 + x * (2 - 1.5 * x));
    const c4 = 0.5 * x * x * (x - 1);
    return s1 * c1 + s2 * c2 + s3 * c3 + s4 * c4;
  }
  // Mean of the input samples swept between two read positions = area sampling.
  // When the platter rips across the track, each output sample spans many input
  // samples; averaging them (instead of point-sampling one) is inherently
  // anti-aliased AND tames the energy dump — a fast drag ROLLS instead of
  // collapsing into a harsh aliased swirl.
  boxAvg(ch, a, b) {
    const pcm = this.pcm;
    if (!pcm || pcm.length === 0) return 0;
    const n = pcm.length;
    let i0 = Math.floor(a < b ? a : b);
    let i1 = Math.floor(a < b ? b : a);
    if (i0 < 0) i0 = 0;
    if (i1 > n - 1) i1 = n - 1;
    if (i1 < i0) i1 = i0;
    let sum = 0;
    for (let i = i0; i <= i1; i++) sum += this.readCh(ch, i);
    return sum / (i1 - i0 + 1);
  }
  // Crisp point-sampling for slow/micro scrubbing (≤1 sample/step), area-averaging
  // for fast sweeps, smoothly crossfaded across 1…3× so there's no seam as the
  // platter accelerates. Preserves the sharp micro-scrub feel exactly.
  readScrub(ch, p0, p1, sp) {
    if (sp <= 1) return this.cubic(ch, p1);
    const avg = this.boxAvg(ch, p0, p1);
    if (sp >= 3) return avg;
    const t = (sp - 1) * 0.5; // 0 at 1×, 1 at 3×
    return this.cubic(ch, p1) * (1 - t) + avg * t;
  }
  process(_inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const frames = output[0].length;
    const nCh = output.length;
    if (!this.active && this.gain < 1e-4) {
      for (let c = 0; c < nCh; c++) output[c].fill(0);
      return true;
    }
    this.pcm = globalThis.__htlPcm.get(this.deckId); // refresh once per block — see module-scope note above
    const last = (this.pcm ? this.pcm.length : 0) - 1;
    // Anti-aliasing: reading faster than 1× is decimation, so source energy above
    // the new Nyquist (= Nyquist/speed) folds back as harsh metallic alias. Lowpass
    // with a cutoff that tracks 1/speed; below 1× the filter opens (no aliasing).
    const speed = Math.abs(this.curStep);
    const targetA = speed > 1 ? 1 - Math.exp(-Math.PI / speed) : 1;
    this.lpA += (targetA - this.lpA) * 0.25; // smooth the cutoff to avoid zipper
    const a = this.lpA;
    const glen = this.glen, gh = this.gh, gwin = this.gwin;
    for (let i = 0; i < frames; i++) {
      this.since++;
      this.gain += (this.gainTarget - this.gain) * this.kGain;
      if (this.ramping) {
        // Motor ramp: ease the read velocity toward the target every sample. Two DIFFERENT
        // physical processes, not one curve (kept in sync by hand with servoStep/brakeFriction
        // in JogEngine.ts; a worklet can't import a TS module — see the design notes there).
        if (this.rampServo) {
          // Catch-up-to-play: a torque-driven 2nd-order servo step response, anchored to the
          // real Technics SL-1200 spec (0.7s standstill-to-speed) — omegaN*tau ~= 6.64 at
          // zeta=1.05 reproduces that, verified by simulation across this exact dt range.
          const omegaN = 6.64 / this.rampTau;
          const accel = omegaN * omegaN * (this.rampTarget - this.curStep) - 2 * 1.05 * omegaN * this.rampA;
          this.rampA += accel * (1 / sampleRate);
          this.curStep += this.rampA * (1 / sampleRate);
        } else {
          // Brake: a simplified LuGre friction/stiction model. Fs/Fc=1.15 is real felt
          // tribology data (AlphaTheta's own jog-tension pads are felt, EP3989600A1).
          const v = this.curStep;
          if (v !== 0) {
            const fc = 0.3 * this.rampTau;
            const fs = 1.15 * fc;
            const g = fc + (fs - fc) * Math.exp(-((v / 0.15) ** 2));
            const zdot = v - (Math.abs(v) * this.rampZ) / g;
            this.rampZ += zdot * (1 / sampleRate);
            const sigma0 = 8 / (0.3 * this.rampTau);
            const sigma2 = 1 / this.rampTau;
            const F = sigma0 * this.rampZ + sigma2 * v;
            const next = v - F * (1 / sampleRate);
            if (next > 0 !== v > 0) { this.curStep = 0; this.rampZ = 0; } else { this.curStep = next; }
          }
        }
        let done = (this.curStep - this.rampTarget) * (this.curStep - this.rampTarget) < 0.0004; // within 0.02
        const p0 = this.pos;
        this.pos += this.curStep;
        let seam = false; // a loop wrap just cut the pointer — don't span-read across it
        if (this.rampLoopEnd > this.rampLoopStart) {
          const ls = this.rampLoopStart, le = this.rampLoopEnd, ln = le - ls;
          if (this.pos >= le) { this.pos = ls + (this.pos - le) % ln; seam = true; }
          else if (this.pos < ls) { this.pos = le - (ls - this.pos) % ln; seam = true; }
        } else {
          if (this.pos < 0) { this.pos = 0; done = true; }
          else if (this.pos > last) { this.pos = last; done = true; }
        }
        const sp = this.curStep < 0 ? -this.curStep : this.curStep;
        const rp0 = seam ? this.pos : p0;
        for (let c = 0; c < nCh; c++) {
          const s = this.readScrub(c, rp0, this.pos, sp);
          const st = this.lp[c] || (this.lp[c] = [0, 0]);
          st[0] += a * (s - st[0]);
          st[1] += a * (st[0] - st[1]);
          output[c][i] = st[1] * this.gain;
        }
        if (++this.rampSince >= this.nominal) { this.rampSince = 0; this.port.postMessage({ type: 'rampPos', pos: this.pos }); }
        if (done) { this.ramping = false; this.gainTarget = 0; this.port.postMessage({ type: 'rampDone', pos: this.pos }); }
        continue;
      }
      if (this.granular) {
        // Follow the finger UNCAPPED (no multi-second catch-up) …
        this.curRaw += (this.stepRaw - this.curRaw) * this.kStep;
        this.pos += this.curRaw;
        if (this.pos < 0) this.pos = 0; else if (this.pos > last) this.pos = last;
        // … and voice two overlapping ~1×-pitch grains anchored to the live position.
        let pa = this.phaseA;
        if (pa >= glen) { pa = 0; this.startA = this.pos; }
        if (pa === gh) this.startB = this.pos; // B re-anchors when its window restarts
        let pb = pa + gh; if (pb >= glen) pb -= glen;
        const wA = gwin[pa], wB = gwin[pb];
        for (let c = 0; c < nCh; c++) {
          output[c][i] = (wA * this.cubic(c, this.startA + pa) + wB * this.cubic(c, this.startB + pb)) * this.gain;
        }
        this.phaseA = pa + 1;
        continue;
      }
      // Continuous resampler (vinyl): GLIDE the read pointer at the platter's MEASURED
      // velocity (curStep eased toward the per-interval step = Δposition / Δtime). This
      // fills the whole gap between sparse position updates, so it never parks. A position-
      // TRACKING filter instead (the old alpha-beta, or a feed-forward + position trim)
      // sees the full inter-update advance as error and rushes the pointer to the target in
      // ~1 ms, then stalls for the rest of the gap — at 60-125 Hz (touch / many mice) that
      // stall is the stutter / DC-buzz that distorted the scrub. Pure feed-forward needs no
      // position correction: each 'move' recomputes step from the ACTUAL current pos, so
      // any drift self-nulls within one update with no built-in convergence stall.
      this.curStep += (this.step - this.curStep) * this.kStep; // ease toward target velocity
      if (this.curStep > 32) this.curStep = 32; else if (this.curStep < -32) this.curStep = -32;
      const p0 = this.pos;
      this.pos += this.curStep; // feed-forward glide (fills the inter-update gap, no parking)
      if (this.pos < 0) { this.pos = 0; if (this.curStep < 0) this.curStep = 0; }
      else if (this.pos > last) { this.pos = last; if (this.curStep > 0) this.curStep = 0; }
      const sp = this.curStep < 0 ? -this.curStep : this.curStep;
      for (let c = 0; c < nCh; c++) {
        const s = this.readScrub(c, p0, this.pos, sp);
        const st = this.lp[c] || (this.lp[c] = [0, 0]);
        st[0] += a * (s - st[0]);       // two cascaded one-poles clean the residual sidelobes
        st[1] += a * (st[0] - st[1]);
        output[c][i] = st[1] * this.gain;
      }
    }
    if (this.gainTarget === 0 && this.gain < 1e-3) this.active = false;
    return true;
  }
}
registerProcessor('scratch', Scratch);
`;
