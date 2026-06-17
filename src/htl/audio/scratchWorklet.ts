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
//
// Loaded via a Blob URL so it's bundler-agnostic (see AudioEngine).
export const SCRATCH_WORKLET_SRC = `
class Scratch extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ch = [];        // Float32Array per channel (the whole track)
    this.len = 0;        // length in samples
    this.pos = 0;        // fractional read pointer (samples)
    this.target = 0;     // latest platter position from the UI (samples)
    this.step = 0;       // per-sample velocity for the current segment (samples)
    this.curStep = 0;    // lightly smoothed step → clean pitch across segments
    this.since = 0;      // output samples since the last 'move' (measures cadence)
    this.interval = 0;   // samples between the last two 'move's (segment length)
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
    this.port.onmessage = (e) => {
      const d = e.data;
      if (d.type === 'load') {
        this.ch = d.channels;
        this.len = d.length;
      } else if (d.type === 'start') {
        this.pos = this.target = d.pos;
        this.step = this.curStep = 0;
        this.granular = false; this.curRaw = 0; // a fresh grab always starts continuous
        this.since = 0;
        this.interval = this.nominal;
        this.lp[0][0] = this.lp[0][1] = this.lp[1][0] = this.lp[1][1] = 0;
        this.lpA = 1;
        this.active = true;
        this.gainTarget = 1;
      } else if (d.type === 'move') {
        // Set the velocity that walks the pointer from where it actually is to the
        // new platter position over ~one update interval. Using the real elapsed
        // interval (not a guess) keeps the motion smooth and drift-free; computing
        // it from the POSITION delta (not the sent velocity) removes the jitter.
        this.interval = this.since > 0 ? this.since : this.nominal;
        this.since = 0;
        this.target = d.pos;
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
      } else if (d.type === 'stop') {
        this.gainTarget = 0; // fade out; go fully idle once silent
      }
    };
  }
  cubic(buf, pos) {
    const i = Math.floor(pos);
    const x = pos - i;
    const n = this.len;
    // Fully clamp ALL four taps to [0, n-1] — granular grains can read past the
    // buffer end (anchor + phase > len), and an unclamped i-1 tap reads undefined → NaN.
    let i0 = i - 1, i1 = i, i2 = i + 1, i3 = i + 2;
    if (i0 < 0) i0 = 0; else if (i0 > n - 1) i0 = n - 1;
    if (i1 < 0) i1 = 0; else if (i1 > n - 1) i1 = n - 1;
    if (i2 < 0) i2 = 0; else if (i2 > n - 1) i2 = n - 1;
    if (i3 < 0) i3 = 0; else if (i3 > n - 1) i3 = n - 1;
    const s1 = buf[i0], s2 = buf[i1], s3 = buf[i2], s4 = buf[i3];
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
  boxAvg(buf, a, b) {
    const n = this.len;
    let i0 = Math.floor(a < b ? a : b);
    let i1 = Math.floor(a < b ? b : a);
    if (i0 < 0) i0 = 0;
    if (i1 > n - 1) i1 = n - 1;
    if (i1 < i0) i1 = i0;
    let sum = 0;
    for (let i = i0; i <= i1; i++) sum += buf[i];
    return sum / (i1 - i0 + 1);
  }
  // Crisp point-sampling for slow/micro scrubbing (≤1 sample/step), area-averaging
  // for fast sweeps, smoothly crossfaded across 1…3× so there's no seam as the
  // platter accelerates. Preserves the sharp micro-scrub feel exactly.
  readScrub(buf, p0, p1, sp) {
    if (sp <= 1) return this.cubic(buf, p1);
    const avg = this.boxAvg(buf, p0, p1);
    if (sp >= 3) return avg;
    const t = (sp - 1) * 0.5; // 0 at 1×, 1 at 3×
    return this.cubic(buf, p1) * (1 - t) + avg * t;
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
    const last = this.len - 1;
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
          const buf = this.ch[c] || this.ch[this.ch.length - 1];
          output[c][i] = buf ? (wA * this.cubic(buf, this.startA + pa) + wB * this.cubic(buf, this.startB + pb)) * this.gain : 0;
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
        const buf = this.ch[c] || this.ch[this.ch.length - 1];
        const s = buf ? this.readScrub(buf, p0, this.pos, sp) : 0;
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
