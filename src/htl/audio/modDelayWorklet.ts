// Modulated fractional delay line for the chorus/flanger engines. Web Audio's native DelayNode
// interpolates fractional delays LINEARLY, which under modulation muffles the highs + flutters
// (the classic "muddy chorus" — DAFx/Välimäki). This reads the ring with 4-POINT CUBIC
// (Catmull-Rom / ~Lagrange-3) interpolation instead → flat magnitude, no HF muffle, click-free.
//
//   input[0] = audio, input[1] = modulation control (LFO + envelope, audio-rate so it's smooth).
//   delay(samples) = base + mod·depth ; feedback is INSIDE the loop with a one-pole high-pass so
//   it can't pile up low-end (the second mud source). Params (base/depth/fb) ride port messages.
export const MOD_DELAY_WORKLET_SRC = `
class ModDelay extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = 4096; // ring length (>= 50 ms @ 48k)
    this.ring = [new Float32Array(this.size), new Float32Array(this.size)];
    this.w = 0;
    this.base = 800; this.depth = 0; this.fb = 0; // samples, samples, 0..1
    this.fbLp = [0, 0]; // one-pole state for the feedback high-pass
    this.port.onmessage = (e) => {
      const d = e.data;
      if (d.base !== undefined) this.base = d.base;
      if (d.depth !== undefined) this.depth = d.depth;
      if (d.fb !== undefined) this.fb = d.fb;
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
  process(inputs, outputs) {
    const sig = inputs[0];
    const mod = inputs[1];
    const out = outputs[0];
    if (!out || out.length === 0) return true;
    const nCh = out.length;
    const frames = out[0].length;
    const maxD = this.size - 4;
    const modCh = mod && mod[0];
    for (let i = 0; i < frames; i++) {
      const m = modCh ? modCh[i] : 0;
      let d = this.base + m * this.depth;
      if (d < 1) d = 1; else if (d > maxD) d = maxD;
      const rp = this.w - d;
      for (let c = 0; c < nCh; c++) {
        const ring = this.ring[c] || this.ring[0];
        const wet = this.cubic(ring, ((rp % this.size) + this.size) % this.size);
        // high-pass the fed-back signal (~230 Hz) so feedback rings instead of muddying.
        this.fbLp[c] += (wet - this.fbLp[c]) * 0.03;
        const fed = wet - this.fbLp[c];
        const inp = sig && sig[c] ? sig[c][i] : 0;
        ring[this.w] = inp + fed * this.fb;
        out[c][i] = wet;
      }
      this.w = (this.w + 1) % this.size;
    }
    return true;
  }
}
registerProcessor('moddelay', ModDelay);
`;
