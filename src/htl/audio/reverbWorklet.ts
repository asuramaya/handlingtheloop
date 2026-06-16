// AudioWorklet source for the reverb TANK — a Jot Feedback Delay Network done right, the
// thing native Web-Audio nodes can't do (single-sample feedback, a true lossless feedback
// matrix, fractional/interpolated modulated delays). Replaces the old native comb-bank.
//
// Per the literature (Jot & Chaigne 1991; Schlecht & Habets 2017; Dattorro 1997):
//   input → 4 series allpass DIFFUSERS (Dattorro lattice, |H|=1)
//         → N=8 delay lines, each: read (interpolated, modulated) → one-pole DAMPING
//           lowpass → per-line Jot decay gain g_i = 10^(−3·L_i/(RT60·fs)) < 1
//         → HOUSEHOLDER lossless mix A = I − (2/N)·u·uᵀ (a shared-sum subtraction, cheap)
//         → write back (input distributed with ± signs for decorrelation)
//         → decorrelated stereo output taps.
// Stability is structural: orthogonal matrix (lossless) + every per-line gain < 1, so the
// only energy loss is the deliberate decay — it can't run away. The slow per-line delay
// MODULATION (character) detunes the modes so the tail never rings metallic (the soft sound).
// Params arrive by PORT MESSAGE, never AudioParams (iOS Safari kills worklets whose
// parameterDescriptors fail to register — see the stretch worklet).
//
// Loaded via a Blob URL (see AudioEngine.initWorklets).

export const REVERB_WORKLET_SRC = `
'use strict';
const N = 8;
const TWO_PI = 6.283185307179586;
// Base delay lengths (samples @ 48 kHz), spread + mutually near-prime; scaled by size.
const BASE48 = [1531, 1789, 2053, 2293, 2557, 2801, 3079, 3331];
const DIFF48 = [281, 431, 587, 743];   // input diffuser lengths (samples @ 48 kHz)
// Style voicing: [sizeMul, diffExtra, dampBias(HF), brightBias].
const STYLES = [
  [1.15, 0.00, 1.0, 1.00], // Hall — big, lush
  [0.80, 0.00, 1.2, 1.00], // Room — tighter, darker
  [0.70, 0.10, 0.8, 1.35], // Plate — dense, bright
  [0.55, 0.04, 1.0, 1.10], // Ambient — short, diffuse
];

class ReverbFDN extends AudioWorkletProcessor {
  constructor() {
    super();
    const sr = sampleRate;
    this.sr = sr;
    const sc = sr / 48000;

    // FDN delay lines (ring buffers sized for max size + modulation headroom).
    this.buf = [];
    this.maxLen = new Int32Array(N);
    this.wi = new Int32Array(N);
    this.baseLen = new Float32Array(N);
    this.curLen = new Float32Array(N);
    this.curLenT = new Float32Array(N);
    this.g = new Float32Array(N);
    this.gT = new Float32Array(N);
    this.lp = new Float32Array(N); // one-pole damping state per line
    this.y = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      this.baseLen[i] = BASE48[i] * sc;
      const ml = Math.ceil(this.baseLen[i] * 2.0) + 64; // headroom for max size + modulation
      this.maxLen[i] = ml;
      this.buf.push(new Float32Array(ml));
      this.curLen[i] = this.baseLen[i];
      this.curLenT[i] = this.baseLen[i];
      this.g[i] = 0.8;
      this.gT[i] = 0.8;
    }
    // Input diffusers (Schroeder/Dattorro allpass lattices).
    this.dbuf = [];
    this.dwi = new Int32Array(4);
    this.dlen = new Int32Array(4);
    for (let i = 0; i < 4; i++) {
      const L = Math.max(1, Math.round(DIFF48[i] * sc));
      this.dlen[i] = L;
      this.dbuf.push(new Float32Array(L));
    }
    this.dg = 0.7; // diffuser coefficient (+ style extra)

    // params (field names == FX param ids)
    this.size = 0.6;
    this.decay = 0.5;
    this.brightness = 0.6;
    this.character = 0.0;
    this.modRate = 0.35;
    this.freeze = 0;
    this.style = 0;

    this.dampC = 0.3;
    this.dampCT = 0.3;
    this.outScale = 0.3; // output normalization (∝ 1/√RT60) so decay doesn't change loudness
    this.outScaleT = 0.3;
    this.phase = 0;
    this.excur = 8 * sc; // modulation peak excursion (samples)
    this.recompute();

    this.port.onmessage = (e) => {
      const d = e.data;
      if (!d) return;
      if (d.k !== undefined) {
        this[d.k] = d.v;
        this.recompute();
      }
    };
  }

  recompute() {
    const v = STYLES[this.style | 0] || STYLES[0];
    const sizeMul = v[0], diffExtra = v[1], dampBias = v[2], brightBias = v[3];
    const sr = this.sr;
    const sc = (0.5 + this.size * 1.0) * sizeMul; // size → delay footprint
    const frozen = this.freeze > 0.5;
    // RT60 from the decay knob, perceptual log map 0.3 s … 9 s.
    const rt = 0.3 * Math.pow(9 / 0.3, this.decay);
    for (let i = 0; i < N; i++) {
      const L = Math.min(this.maxLen[i] - 2, this.baseLen[i] * sc);
      this.curLenT[i] = L;
      // Jot per-line gain; freeze → ~unity hold (still < 1, so bounded).
      this.gT[i] = frozen ? 0.9995 : Math.pow(10, (-3 * L) / (rt * sr));
    }
    // Damping one-pole coefficient from brightness; freeze opens it (transparent hold).
    const fc = Math.min(19000, 1500 * Math.pow(18000 / 1500, this.brightness) * brightBias) / dampBias;
    const x = Math.exp((-TWO_PI * Math.min(fc, sr * 0.49)) / sr);
    this.dampCT = frozen ? 1.0 : 1 - x; // c=1 → no damping; small c → dark
    this.dg = Math.min(0.92, 0.7 + diffExtra);
    // a long tail accumulates energy over time; quiet the per-sample output so a longer RT60
    // rings longer at roughly constant loudness instead of getting louder.
    this.outScaleT = Math.max(0.08, Math.min(0.6, 0.5 / Math.sqrt(rt)));
  }

  process(inputs, outputs) {
    const out = outputs[0];
    if (!out || out.length < 2) return true;
    const inp = inputs[0];
    const inL = inp && inp[0] ? inp[0] : null;
    const inR = inp && inp[1] ? inp[1] : inL;
    const oL = out[0], oR = out[1];
    const n = oL.length;
    const buf = this.buf, wi = this.wi, g = this.g, lp = this.lp, y = this.y, curLen = this.curLen;
    const dbuf = this.dbuf, dwi = this.dwi, dlen = this.dlen, dg = this.dg;
    const frozen = this.freeze > 0.5;
    const modOn = this.character > 0.0001;

    for (let s = 0; s < n; s++) {
      // smooth params toward targets (≈10 ms) to avoid zipper on knob moves
      this.dampC += (this.dampCT - this.dampC) * 0.002;
      this.outScale += (this.outScaleT - this.outScale) * 0.002;
      for (let i = 0; i < N; i++) {
        g[i] += (this.gT[i] - g[i]) * 0.002;
        curLen[i] += (this.curLenT[i] - curLen[i]) * 0.002;
      }

      let xin = inL ? (inR ? 0.5 * (inL[s] + inR[s]) : inL[s]) : 0;
      if (frozen) xin = 0; // hold the captured tail

      // input diffusion — 4 series allpasses, Dattorro lattice: v=x−g·v[n−L]; y=g·v+v[n−L]
      for (let d = 0; d < 4; d++) {
        const db = dbuf[d], L = dlen[d];
        let p = dwi[d];
        const r = db[p];
        const vv = xin - dg * r;
        db[p] = vv;
        xin = dg * vv + r;
        p++;
        if (p >= L) p = 0;
        dwi[d] = p;
      }

      this.phase += (TWO_PI * this.modRate) / this.sr;
      if (this.phase > TWO_PI) this.phase -= TWO_PI;

      // read every line: interpolated (modulated) tap → damping → Jot gain
      let S = 0;
      for (let i = 0; i < N; i++) {
        const ml = this.maxLen[i], b = buf[i];
        const mod = modOn ? this.character * this.excur * Math.sin(this.phase + i * 0.7) : 0;
        let rp = wi[i] - curLen[i] - mod;
        while (rp < 0) rp += ml;
        while (rp >= ml) rp -= ml;
        const ri = rp | 0;
        const frac = rp - ri;
        const a0 = b[ri];
        const a1 = b[ri + 1 >= ml ? 0 : ri + 1];
        const di = a0 + (a1 - a0) * frac;
        lp[i] += this.dampC * (di - lp[i]); // one-pole damping (HF decays faster)
        const yi = g[i] * lp[i];
        y[i] = yi;
        S += yi;
      }
      const hh = (2 / N) * S; // Householder shared sum (A = I − (2/N)·u·uᵀ)

      // write back the lossless-mixed feedback + the diffused input (± signs decorrelate)
      for (let i = 0; i < N; i++) {
        const bi = i & 1 ? -0.5 : 0.5;
        const w = wi[i];
        buf[i][w] = xin * bi + (y[i] - hh);
        let nw = w + 1;
        if (nw >= this.maxLen[i]) nw = 0;
        wi[i] = nw;
      }

      // decorrelated stereo: even lines → L, odd → R
      let L = 0, R = 0;
      for (let i = 0; i < N; i++) {
        if ((i & 1) === 0) L += y[i];
        else R += y[i];
      }
      oL[s] = L * this.outScale;
      oR[s] = R * this.outScale;
    }
    return true;
  }
}
registerProcessor('reverbfdn', ReverbFDN);
`;
