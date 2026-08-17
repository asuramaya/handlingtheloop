// Modulated fractional delay line for the chorus/flanger engines. Web Audio's native DelayNode
// interpolates fractional delays LINEARLY, which under modulation muffles the highs + flutters
// (the classic "muddy chorus" — DAFx/Välimäki). This reads the ring with 4-POINT CUBIC
// (Catmull-Rom / ~Lagrange-3) interpolation instead → flat magnitude, no HF muffle, click-free.
//
//   input[0] = audio, input[1] = the ENVELOPE-FOLLOWER control only (unipolar, audio-rate).
//   output[0] = audio (stereo); output[1] = this voice's live modulation m = lfoOn·LFO(φ_k)+env
//   (mono, ±); output[2] = its LFO phase φ_k (mono, 0‥1) — the device taps voice 0's pair so the
//   viz draws the REAL sweep, not a main-thread guess of it.
//   delay(samples) = base + depth · (lfoOn·LFO(φ_k) + env)
//
// ★ THE LFO LIVES IN HERE, PER VOICE, WITH ITS OWN PHASE — not on a shared bus. A multi-voice
// chorus/flanger whose voices all ride ONE modulation signal isn't an ensemble at all: N taps
// spread across ±15% of the base delay that all move together are a STATIC FIR comb on the wet
// (passbands only at multiples of 1/tap-spacing, everything between nulled — at 12 chorus voices
// that's ~2 kHz spacing, i.e. the wet is gone), and the shared LFO only rotates that comb's phase
// against the dry. Real ensemble units (Solina, Dimension D, Juno) run their voices at DIFFERENT
// LFO PHASES — that's the whole trick — so voice k here gets phase offset k/N (posted as `phase`)
// and generates its own sine/tri/square from `lfoHz`, phase-continuous across rate changes (an
// accumulator, so retuning never jumps the delay). The envelope still arrives as a signal on
// input 1 (it's program-dependent, it can't be synthesised here); LFO/ENV/BOTH is `lfoOn` + the
// device muting the env feed, same as before.
//
// Feedback is INSIDE the loop with a one-pole high-pass so it can't pile up low-end (the second
// mud source). Params ride port messages. Every value written into the ring is guarded finite —
// a single NaN/Inf reaching a delay line with feedback is PERMANENT silence downstream, with the
// transport still running (the "engine dies, playback continues with no sound" signature), and
// nothing else in the graph could ever flush it. `{dispose:true}` makes process() return false so
// a retired voice (the device rebuilds on every STAGES/mode change) actually goes away instead of
// living forever as an active-source node the engine can never collect.
export const MOD_DELAY_WORKLET_SRC = `
class ModDelay extends AudioWorkletProcessor {
  constructor() {
    super();
    // ring length ≥ 100 ms at THIS sample rate (pow-2 for the wrap arithmetic) — a fixed 4096
    // was 42 ms at 96 kHz, and CHORUS's 20.7 ms base + full depth·throw·(LFO+ENV) can ask ~70 ms
    this.size = 1 << Math.ceil(Math.log2(0.1 * sampleRate));
    this.ring = [new Float32Array(this.size), new Float32Array(this.size)];
    this.w = 0;
    this.base = 800; this.depth = 0; this.fb = 0; // samples, samples, 0..1 — the POSTED targets
    this.depthS = 0; this.fbS = 0; // …and their SLEWED live values (see process): a posted depth
    // used to land instantly, and delay = base + m·depth means a DEPTH drag (the XY pad drags it
    // continuously) jumped the read pointer by m·Δdepth on every message — a splice per frame of
    // the drag (fxlab --mod-audit: ×12‥16 the median step). One-pole slews (see process).
    this.lfoHz = 0.5; this.hzS = 0.5; this.wave = 0; this.phase = 0; this.lfoOn = 1; // hzS: glided rate —
    // a RATE/SYNC jump changes the vibrato depth (delay velocity) instantly otherwise; ~100 ms glide
    this.phi = 0; // the LFO accumulator, cycles — offset by this.phase at read time
    this.p = 0; // the last read phase (phi+phase, wrapped) — for output[2]
    this.sq = [0, 0]; // slewed square, PER CHANNEL (each channel reads the LFO at its own phase)
    this.spread = 0;  // STEREO WIDTH: cycles of LFO phase the right channel leads the left by.
    // 0 keeps both channels on one phase — bit-identical to the mono-safe behaviour, and the
    // default, because a stereo spread is exactly what a mono sum cancels: the two channels comb
    // the dry differently, so summing them fills each channel's notches with the other's peaks
    // and the effect thins out. That trade belongs to the operator, not to a default.
    this.fbLp = [0, 0]; // one-pole state for the feedback high-pass
    this.alive = true;
    this.port.onmessage = (e) => {
      const d = e.data;
      if (d.dispose) { this.alive = false; return; }
      if (d.probe) { this.port.postMessage({ probe: { base: this.base, depth: this.depth, depthS: this.depthS, fb: this.fb, lfoHz: this.lfoHz, hzS: this.hzS, wave: this.wave, phase: this.phase, lfoOn: this.lfoOn, phi: this.phi, spread: this.spread, alive: this.alive } }); return; }
      if (d.base !== undefined) this.base = d.base;
      if (d.depth !== undefined) this.depth = d.depth;
      if (d.fb !== undefined) this.fb = d.fb;
      if (d.lfoHz !== undefined) this.lfoHz = d.lfoHz;
      if (d.wave !== undefined) this.wave = d.wave;
      if (d.phase !== undefined) this.phase = d.phase;
      if (d.lfoOn !== undefined) this.lfoOn = d.lfoOn;
      if (d.spread !== undefined) this.spread = d.spread;
    };
  }
  cubic(buf, pos) {
    const n = this.size;
    const i = Math.floor(pos);
    const x = pos - i;
    const i0 = ((i - 1) % n + n) % n, i1 = (i % n + n) % n, i2 = ((i + 1) % n + n) % n, i3 = ((i + 2) % n + n) % n;
    const s1 = buf[i0], s2 = buf[i1], s3 = buf[i2], s4 = buf[i3];
    const c1 = x * (-0.5 + x * (1 - 0.5 * x));
    const c2 = 1 + x * x * (1.5 * x - 2.5);
    const c3 = x * (0.5 + x * (2 - 1.5 * x));
    const c4 = 0.5 * x * x * (x - 1);
    return s1 * c1 + s2 * c2 + s3 * c3 + s4 * c4;
  }
  // -1..1 at phase (phi + phase + this channel's spread) — sine / triangle / slewed square.
  // Channel 0's phase is the one reported on output[2] (the viz reads the tapped voice's LFO).
  lfo(c) {
    let p = this.phi + this.phase + (c === 1 ? this.spread * 0.5 : 0);
    p -= Math.floor(p);
    if (c === 0) this.p = p;
    if (this.wave === 1) return p < 0.5 ? 4 * p - 1 : 3 - 4 * p;
    if (this.wave === 2) {
      const target = p < 0.5 ? 1 : -1;
      this.sq[c] += (target - this.sq[c]) * 0.004; // ~5 ms edge @48k
      return this.sq[c];
    }
    return Math.sin(6.283185307179586 * p);
  }
  process(inputs, outputs) {
    if (!this.alive) return false;
    const sig = inputs[0];
    const env = inputs[1];
    const out = outputs[0];
    if (!out || out.length === 0) return true;
    const nCh = out.length;
    const frames = out[0].length;
    const mOut = outputs[1] && outputs[1][0];
    const pOut = outputs[2] && outputs[2][0];
    const maxD = this.size - 4;
    const envCh = env && env[0];
    const slew = 1 - Math.exp(-1 / (0.02 * sampleRate)); // 20 ms one-pole (feedback)
    const hslew = 1 - Math.exp(-1 / (0.1 * sampleRate)); // 100 ms for the LFO rate
    const dslew = 1 - Math.exp(-1 / (0.06 * sampleRate)); // 60 ms for depth: CHORUS's full DEPTH
    // range is ~4 ms of delay, and 4 ms in 20 ms is a 20% pitch swoop — still a "step" to the ear
    for (let i = 0; i < frames; i++) {
      const env = envCh ? envCh[i] : 0;
      const m = (this.lfoOn ? this.lfo(0) : 0) + env;
      if (mOut) mOut[i] = m;
      if (pOut) pOut[i] = this.p;
      this.hzS += (this.lfoHz - this.hzS) * hslew;
      this.phi += this.hzS / sampleRate;
      if (this.phi >= 1) this.phi -= 1;
      this.depthS += (this.depth - this.depthS) * dslew;
      this.fbS += (this.fb - this.fbS) * slew;
      for (let c = 0; c < nCh; c++) {
        // Each channel reads the LFO at its OWN phase when spread > 0 — the delay itself differs
        // per side, which is what makes an ensemble wide. At spread 0 this is m for every channel.
        const mc = c === 0 || this.spread === 0 ? m : (this.lfoOn ? this.lfo(c) : 0) + env;
        let d = this.base + mc * this.depthS;
        if (!(d >= 1)) d = 1; else if (d > maxD) d = maxD; // !(d>=1) also catches NaN
        const rp = this.w - d;
        const ring = this.ring[c] || this.ring[0];
        const wet = this.cubic(ring, ((rp % this.size) + this.size) % this.size);
        // high-pass the fed-back signal (~230 Hz) so feedback rings instead of muddying.
        this.fbLp[c] += (wet - this.fbLp[c]) * 0.03;
        const fed = wet - this.fbLp[c];
        let inp = sig && sig[c] ? sig[c][i] : 0;
        let v = inp + fed * this.fbS;
        if (!(v > -1e6 && v < 1e6)) { v = 0; this.fbLp[c] = 0; } // NaN/Inf/runaway → flush, don't poison
        ring[this.w] = v;
        out[c][i] = wet;
      }
      this.w = (this.w + 1) % this.size;
    }
    return true;
  }
}
registerProcessor('moddelay', ModDelay);
`;
