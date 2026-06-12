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
    this.port.onmessage = (e) => {
      const d = e.data;
      if (d.type === 'load') {
        this.ch = d.channels;
        this.len = d.length;
      } else if (d.type === 'start') {
        this.pos = this.target = d.pos;
        this.step = this.curStep = 0;
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
        let s = (this.target - this.pos) / this.interval;
        if (s > 32) s = 32; else if (s < -32) s = -32; // guard against a bad frame
        this.step = s;
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
    const i0 = i - 1 < 0 ? 0 : i - 1;
    const i1 = i < 0 ? 0 : i > n - 1 ? n - 1 : i;
    const i2 = i + 1 > n - 1 ? n - 1 : i + 1;
    const i3 = i + 2 > n - 1 ? n - 1 : i + 2;
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
    for (let i = 0; i < frames; i++) {
      this.since++;
      // Smooth the segment velocity (kills the 60 Hz pitch stair-step) and walk the
      // pointer. Position stays accurate because each 'move' recomputes step from
      // the real pos, so a lagging curStep is corrected on the next segment.
      const p0 = this.pos;
      this.curStep += (this.step - this.curStep) * this.kStep;
      this.pos += this.curStep;
      if (this.pos < 0) { this.pos = 0; this.curStep = 0; }
      else if (this.pos > last) { this.pos = last; this.curStep = 0; }
      const sp = this.curStep < 0 ? -this.curStep : this.curStep;
      this.gain += (this.gainTarget - this.gain) * this.kGain;
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
