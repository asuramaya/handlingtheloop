// AudioWorklet source for the bitcrusher (CRUSH). Sample-rate reduction is a per-sample
// sample-and-hold, which native nodes can't express — hence a worklet. Two degradations:
//   • BIT-DEPTH quantize (round to N levels → quantization grit), fractional bits ok.
//   • SAMPLE-RATE reduction (hold each latched sample for `rate` output samples → aliasing).
// Plus JITTER (random wobble on the hold period → grungier, Decimort-style) and MODE (the
// decimation ALGORITHM): S&H (clean hold) · ZERO (Pixelator zero-pad) · VINTAGE (linear
// interpolate between holds = a softer DAC reconstruction) · JITTER (S&H with a jitter floor).
// Params ride PORT MESSAGES, never AudioParams (iOS Safari kills worklets whose
// parameterDescriptors fail to register — the project-wide rule). Loaded via a Blob URL.
export const CRUSH_WORKLET_SRC = `
class Crush extends AudioWorkletProcessor {
  constructor() {
    super();
    this.bits = 16;    // bit depth (fractional allowed)
    this.rateDiv = 1;  // output samples each latched sample is held for (sample-rate reduction)
    this.jitter = 0;   // 0..1 hold-period wobble
    this.mode = 0;     // 0 S&H, 1 ZERO-pad, 2 VINTAGE (interp), 3 JITTER
    this.cnt = 1e9;    // samples since the last latch (huge → latch on the first sample)
    this.period = 1;
    this.held = [0, 0];
    this.prev = [0, 0];
    this.port.onmessage = (e) => {
      const d = e.data;
      if (d.bits !== undefined) this.bits = d.bits;
      if (d.rate !== undefined) this.rateDiv = d.rate;
      if (d.jitter !== undefined) this.jitter = d.jitter;
      if (d.mode !== undefined) this.mode = d.mode;
    };
  }
  quant(x) {
    const L = Math.pow(2, this.bits - 1);
    if (L >= 32768) return x; // ~16-bit and up = transparent
    return Math.round(x * L) / L;
  }
  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const nCh = output.length;
    const frames = output[0].length;
    for (let i = 0; i < frames; i++) {
      if (this.cnt >= this.period) {
        // Latch a fresh (quantized) sample and pick the next hold period.
        this.cnt = 0;
        let p = this.rateDiv;
        const jit = this.jitter + (this.mode === 3 ? 0.35 : 0); // JITTER mode floors the wobble
        if (jit > 0) p *= 1 + (Math.random() * 2 - 1) * (jit > 0.95 ? 0.95 : jit) * 0.9;
        this.period = p < 1 ? 1 : p;
        for (let c = 0; c < nCh; c++) {
          this.prev[c] = this.held[c];
          this.held[c] = this.quant(input && input[c] ? input[c][i] : 0);
        }
      }
      const frac = this.period > 0 ? this.cnt / this.period : 0;
      for (let c = 0; c < nCh; c++) {
        let o;
        if (this.mode === 1) o = this.cnt === 0 ? this.held[c] : 0; // ZERO pad: the block-start sample, then zeros
        else if (this.mode === 2) o = this.prev[c] + (this.held[c] - this.prev[c]) * frac; // VINTAGE: smooth the staircase
        else o = this.held[c]; // S&H / JITTER
        output[c][i] = o;
      }
      this.cnt++;
    }
    return true;
  }
}
registerProcessor('crush', Crush);
`;
