// Minimal iterative radix-2 Cooley–Tukey FFT (power-of-two only), used by the
// in-browser STFT/ISTFT for neural stem separation. No deps; plain Float32.
export class FFT {
  readonly n: number;
  private readonly rev: Uint32Array;
  private readonly cos: Float32Array;
  private readonly sin: Float32Array;

  constructor(n: number) {
    if ((n & (n - 1)) !== 0) throw new Error("FFT size must be a power of two");
    this.n = n;
    const logn = Math.log2(n);
    this.rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let x = i;
      let r = 0;
      for (let j = 0; j < logn; j++) {
        r = (r << 1) | (x & 1);
        x >>= 1;
      }
      this.rev[i] = r >>> 0;
    }
    this.cos = new Float32Array(n / 2);
    this.sin = new Float32Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((-2 * Math.PI * i) / n);
      this.sin[i] = Math.sin((-2 * Math.PI * i) / n);
    }
  }

  // In-place complex FFT (inverse when `inv`). re/im are length n.
  transform(re: Float32Array, im: Float32Array, inv = false): void {
    const n = this.n;
    const rev = this.rev;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i];
        re[i] = re[j];
        re[j] = t;
        t = im[i];
        im[i] = im[j];
        im[j] = t;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1;
      const step = n / len;
      for (let i = 0; i < n; i += len) {
        for (let k = 0, idx = 0; k < half; k++, idx += step) {
          const wr = this.cos[idx];
          const wi = inv ? -this.sin[idx] : this.sin[idx];
          const a = i + k;
          const b = a + half;
          const xr = re[b] * wr - im[b] * wi;
          const xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr;
          im[b] = im[a] - xi;
          re[a] += xr;
          im[a] += xi;
        }
      }
    }
    if (inv) {
      const inv_n = 1 / n;
      for (let i = 0; i < n; i++) {
        re[i] *= inv_n;
        im[i] *= inv_n;
      }
    }
  }
}

// Periodic Hann window of length n (== torch.hann_window(n, periodic=True)).
export function hannPeriodic(n: number): Float32Array {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}

// numpy mode="reflect" padding (reflect without repeating the edge sample).
export function reflectPad(x: Float32Array, pad: number): Float32Array {
  const n = x.length;
  const out = new Float32Array(n + 2 * pad);
  out.set(x, pad);
  for (let i = 0; i < pad; i++) {
    out[pad - 1 - i] = x[i + 1]; // left reflect
    out[pad + n + i] = x[n - 2 - i]; // right reflect
  }
  return out;
}

// ─── HT-Demucs STFT / iSTFT ───────────────────────────────────────────────────
// The demucs ONNX *core* takes a CaC spectrogram in and returns one out; STFT and
// iSTFT happen here in JS (the same split the Rust port uses). These are BIT-EXACT
// against PyTorch `_spec`/`_ispec` (validated to <1.2e-7). Fixed nfft=4096, hop=1024;
// the model input is hard-bound to 343980 samples → 336 frames.
export const DEMUCS_NFFT = 4096;
export const DEMUCS_HOP = 1024;
export const DEMUCS_BINS = DEMUCS_NFFT / 2; // 2048 (Nyquist dropped)
const DEMUCS_WIN = hannPeriodic(DEMUCS_NFFT);

// Asymmetric reflect pad matching demucs `_spec` (mirror without repeating edges).
function reflectPadLR(x: Float32Array, left: number, right: number): Float32Array {
  const n = x.length;
  const out = new Float32Array(n + left + right);
  let k = 0;
  for (let i = left; i >= 1; i--) out[k++] = x[i % n];
  for (let i = 0; i < n; i++) out[k++] = x[i];
  for (let i = 1; i <= right; i++) out[k++] = x[(n - 1) - (i % (n - 1))];
  return out;
}

// One channel → frame-major {re,im} of `frames × DEMUCS_BINS` (frames = ceil(len/hop)).
function demucsStftChannel(fft: FFT, samples: Float32Array): { re: Float32Array; im: Float32Array; frames: number } {
  const hl = DEMUCS_HOP;
  const le = Math.ceil(samples.length / hl);
  const specPad = (hl / 2) * 3; // 1536
  const sp = reflectPadLR(samples, specPad, specPad + (le * hl - samples.length));
  const padded = reflectPadLR(sp, DEMUCS_NFFT / 2, DEMUCS_NFFT / 2);
  const total = Math.floor((padded.length - DEMUCS_NFFT) / hl) + 1; // le + 4
  const re = new Float32Array(le * DEMUCS_BINS);
  const im = new Float32Array(le * DEMUCS_BINS);
  const fr = new Float32Array(DEMUCS_NFFT);
  const fi = new Float32Array(DEMUCS_NFFT);
  const norm = 1 / Math.sqrt(DEMUCS_NFFT);
  let o = 0;
  for (let f = 0; f < total; f++) {
    if (f < 2 || f >= 2 + le) continue; // keep frames [2 .. 2+le)
    const s = f * hl;
    for (let i = 0; i < DEMUCS_NFFT; i++) {
      fr[i] = padded[s + i] * DEMUCS_WIN[i];
      fi[i] = 0;
    }
    fft.transform(fr, fi, false);
    for (let b = 0; b < DEMUCS_BINS; b++) {
      re[o * DEMUCS_BINS + b] = fr[b] * norm;
      im[o * DEMUCS_BINS + b] = fi[b] * norm;
    }
    o++;
  }
  return { re, im, frames: le };
}

// Stereo STFT → the model's CaC `mag` tensor data: [4, BINS, frames] bin-major,
// channel order [L_re, L_im, R_re, R_im].
export function demucsMag(fft: FFT, left: Float32Array, right: Float32Array): { mag: Float32Array; frames: number } {
  const L = demucsStftChannel(fft, left);
  const R = demucsStftChannel(fft, right);
  const frames = L.frames;
  const stride = DEMUCS_BINS * frames;
  const mag = new Float32Array(4 * stride);
  for (let b = 0; b < DEMUCS_BINS; b++) {
    for (let t = 0; t < frames; t++) {
      const ft = t * DEMUCS_BINS + b;
      mag[0 * stride + b * frames + t] = L.re[ft];
      mag[1 * stride + b * frames + t] = L.im[ft];
      mag[2 * stride + b * frames + t] = R.re[ft];
      mag[3 * stride + b * frames + t] = R.im[ft];
    }
  }
  return { mag, frames };
}

// One CaC channel (re/im bin-major [BINS*frames]) → `outLen` time-domain samples.
// Mirrors demucs `_ispec` (re-pad 2 frames, overlap-add, trim).
export function demucsIstftChannel(fft: FFT, re: Float32Array, im: Float32Array, frames: number, outLen: number): Float32Array {
  const hl = DEMUCS_HOP;
  const numFrames = frames + 4;
  const paddedLen = (numFrames - 1) * hl + DEMUCS_NFFT;
  const out = new Float32Array(paddedLen);
  const wsum = new Float32Array(paddedLen);
  const fr = new Float32Array(DEMUCS_NFFT);
  const fi = new Float32Array(DEMUCS_NFFT);
  const nrm = Math.sqrt(DEMUCS_NFFT);
  for (let f = 0; f < numFrames; f++) {
    fr.fill(0);
    fi.fill(0);
    const sf = f - 2;
    if (sf >= 0 && sf < frames) {
      for (let b = 0; b < DEMUCS_BINS; b++) {
        fr[b] = re[b * frames + sf];
        fi[b] = im[b * frames + sf];
      }
      fi[0] = 0; // DC imag = 0 (Nyquist bin stays 0)
    }
    for (let b = 1; b < DEMUCS_BINS; b++) {
      fr[DEMUCS_NFFT - b] = fr[b]; // conjugate symmetry
      fi[DEMUCS_NFFT - b] = -fi[b];
    }
    fft.transform(fr, fi, true);
    const off = f * hl;
    for (let i = 0; i < DEMUCS_NFFT; i++) {
      const v = fr[i] * nrm;
      out[off + i] += v * DEMUCS_WIN[i];
      wsum[off + i] += DEMUCS_WIN[i] * DEMUCS_WIN[i];
    }
  }
  for (let i = 0; i < paddedLen; i++) if (wsum[i] > 0) out[i] /= wsum[i];
  const start = DEMUCS_NFFT / 2 + (hl / 2) * 3; // 3584
  return out.slice(start, start + outLen);
}
