// AudioWorklet source for key-lock (master tempo). A time-domain 2-tap delay
// pitch-shifter: two read taps sweep through a ring buffer half a buffer apart,
// cross-faded with a sine window, so the audio is repitched without changing
// duration. Inserted after the deck's buffer source — when the source plays
// faster (tempo up, pitch up like vinyl), we set ratio = 1/playbackRate to shift
// the pitch back down, netting tempo change with the original key.
//
// At ratio == 1 (key-lock off) it passes input straight through, so it's
// transparent. The ±8% tempo range means small shifts, where this stays clean.
//
// Loaded via a Blob URL so it works regardless of bundler (see AudioEngine).
export const PITCH_WORKLET_SRC = `
class PitchShift extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'ratio', defaultValue: 1, minValue: 0.4, maxValue: 2.5, automationRate: 'k-rate' }];
  }
  constructor() {
    super();
    this.L = 4096;
    this.bufs = [new Float32Array(this.L), new Float32Array(this.L)];
    this.writeIdx = 0;
    this.phase = 0;
  }
  read(buf, r) {
    const L = this.L;
    r = ((r % L) + L) % L;
    // 4-point Catmull-Rom cubic — smoother than linear, so the resampled (key-
    // shifted) signal keeps more high end and aliases less, especially on big
    // shifts. Wrap all four taps around the ring.
    const i1 = Math.floor(r);
    const f = r - i1;
    const i0 = i1 - 1 < 0 ? L - 1 : i1 - 1;
    const i2 = i1 + 1 >= L ? 0 : i1 + 1;
    const i3 = i1 + 2 >= L ? i1 + 2 - L : i1 + 2;
    const y0 = buf[i0], y1 = buf[i1], y2 = buf[i2], y3 = buf[i3];
    const a = -0.5 * y0 + 1.5 * y1 - 1.5 * y2 + 0.5 * y3;
    const b = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3;
    const c = -0.5 * y0 + 0.5 * y2;
    return ((a * f + b) * f + c) * f + y1;
  }
  process(inputs, outputs, params) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const frames = output[0].length;
    const nCh = output.length;
    const L = this.L;
    const ratio = params.ratio.length > 0 ? params.ratio[params.ratio.length - 1] : 1;
    const transparent = Math.abs(ratio - 1) < 1e-4;
    const haveInput = input && input.length > 0;
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < nCh; c++) {
        const inCh = haveInput ? input[c] || input[input.length - 1] : null;
        this.bufs[c][this.writeIdx] = inCh ? inCh[i] : 0;
      }
      if (transparent) {
        for (let c = 0; c < nCh; c++) {
          const inCh = haveInput ? input[c] || input[input.length - 1] : null;
          output[c][i] = inCh ? inCh[i] : 0;
        }
      } else {
        const p1 = this.phase;
        const p2 = p1 + 0.5 >= 1 ? p1 - 0.5 : p1 + 0.5;
        const w1 = Math.sin(Math.PI * p1);
        const w2 = Math.sin(Math.PI * p2);
        const r1 = this.writeIdx - p1 * L;
        const r2 = this.writeIdx - p2 * L;
        for (let c = 0; c < nCh; c++) {
          output[c][i] = w1 * this.read(this.bufs[c], r1) + w2 * this.read(this.bufs[c], r2);
        }
        this.phase += (1 - ratio) / L;
        this.phase -= Math.floor(this.phase);
      }
      this.writeIdx = this.writeIdx + 1 >= L ? 0 : this.writeIdx + 1;
    }
    return true;
  }
}
registerProcessor('pitch-shift', PitchShift);
`;
