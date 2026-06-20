// Rolling capture buffer on the master — the "grab what just happened" ring. A circular Float32
// buffer per channel is written every render quantum; a {grab, frames} message dumps the LAST N
// frames (transferred back as ArrayBuffers) so the main thread can build an AudioBuffer. The node
// is always pulled (its silent output stays connected toward the destination), so the ring is
// continuously fresh and a grab is retroactive — capturing the moment AFTER it already passed.
export const RING_SECONDS = 24; // how much history to hold (~9 MB stereo @ 48k); caps a grab

export const RING_REC_WORKLET_SRC = `
class RingRec extends AudioWorkletProcessor {
  constructor(opts) {
    super();
    this.size = (opts.processorOptions && opts.processorOptions.size) | 0;
    this.bufL = new Float32Array(this.size);
    this.bufR = new Float32Array(this.size);
    this.w = 0;        // write head
    this.filled = 0;   // valid frames so far (≤ size)
    this.port.onmessage = (e) => {
      const d = e.data || {};
      if (d.type !== 'grab') return;
      const n = Math.min(this.filled, Math.max(0, d.frames | 0));
      const outL = new Float32Array(n);
      const outR = new Float32Array(n);
      const start = (this.w - n + this.size * 2) % this.size; // n frames ending at the write head
      for (let i = 0; i < n; i++) {
        const j = (start + i) % this.size;
        outL[i] = this.bufL[j];
        outR[i] = this.bufR[j];
      }
      this.port.postMessage({ type: 'grab', frames: n, ch0: outL.buffer, ch1: outR.buffer }, [outL.buffer, outR.buffer]);
    };
  }
  process(inputs) {
    const input = inputs[0];
    if (input && input.length) {
      const L = input[0];
      const R = input[1] || input[0];
      const frames = L.length;
      for (let i = 0; i < frames; i++) {
        this.bufL[this.w] = L[i];
        this.bufR[this.w] = R[i];
        this.w = (this.w + 1) % this.size;
      }
      this.filled = Math.min(this.size, this.filled + frames);
    }
    return true; // never let the engine GC this node — it must keep buffering
  }
}
registerProcessor('ringrec', RingRec);
`;
