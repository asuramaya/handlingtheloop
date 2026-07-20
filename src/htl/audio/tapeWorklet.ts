// AudioWorklet source for the saturator's TAPE style — a lightweight, STATEFUL hysteresis
// model, replacing the memoryless WaveShaper the other 4 styles use. A WaveShaper can only ever
// be a fixed function of the instantaneous sample; real tape has MEMORY (the same input level
// produces a slightly different output depending on whether the signal is rising or falling,
// and the head/tape system has its own response time) — that loop is the one thing a static
// curve table structurally cannot express, so it's the one style that gets a worklet.
//
// Per-sample model (each channel independent):
//   state += (x − state) · poleAlpha          — a one-pole "head" lag (softens fast transients)
//   loop   = sign(x − prevX) · HYST_W · hot    — direction-dependent bias = the hysteresis LOOP
//   y      = tanh(hot · (state + loop)) / hot
// `hot` plays EXACTLY the role SaturatorFx's static curves call `hot` (steepness into the
// nonlinear region, driven by PUNISH/HEAT) — it is NOT drive. DRIVE is a pre-gain already
// applied upstream by SaturatorFx's own native GainNode before the signal ever reaches this
// worklet (same as every other style), so re-applying it in here would double it. Normalizing
// by `hot` keeps the small-signal slope near unity at hot's baseline, same philosophy as
// SaturatorFx's normalizeSlope for the static curves.
//
// `hot` rides a port message (never an AudioParam — the project-wide rule: iOS Safari kills a
// worklet whose parameterDescriptors fail to register). Falls back to the native TAPE curve
// (SaturatorFx's own makeCurve(1, hot)) if this module never loads, exactly like ModFx's
// chorus/flanger worklet falls back to a native DelayNode.
export const TAPE_WORKLET_SRC = `
const HYST_W = 0.18;      // hysteresis loop half-width (normalized units, pre-tanh)
const POLE_HZ = 9000;     // one-pole head-lag corner — mild, softens only the top octave or so

class Tape extends AudioWorkletProcessor {
  constructor() {
    super();
    this.hot = 1.4; // matches SaturatorFx's own unpunished baseline
    this.state = [0, 0];
    this.prevX = [0, 0];
    this.poleAlpha = 1 - Math.exp((-2 * Math.PI * POLE_HZ) / sampleRate);
    this.port.onmessage = (e) => {
      if (e.data.hot !== undefined) this.hot = e.data.hot;
    };
  }
  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const nCh = output.length;
    const frames = output[0].length;
    const hot = this.hot > 1e-4 ? this.hot : 1e-4;
    for (let c = 0; c < nCh; c++) {
      const inCh = input && input[c] ? input[c] : null;
      const outCh = output[c];
      let st = this.state[c] || 0;
      let px = this.prevX[c] || 0;
      for (let i = 0; i < frames; i++) {
        const x = inCh ? inCh[i] : 0;
        st += (x - st) * this.poleAlpha;
        const d = x - px;
        const loop = (d > 0 ? HYST_W : d < 0 ? -HYST_W : 0) * hot;
        outCh[i] = Math.tanh(hot * st + loop) / hot;
        px = x;
      }
      this.state[c] = st;
      this.prevX[c] = px;
    }
    return true;
  }
}
registerProcessor('tape', Tape);
`;
