/// <reference lib="webworker" />
// Stem-separation worker: the ENTIRE heavy pipeline (STFT → 4 ONNX nets → softmask
// → ISTFT) runs here, off the main thread, so the app stays responsive while a
// track separates. The main thread only resamples to/from 44.1 kHz (async, cheap)
// and ships planar Float32 channels in/out as transferables (zero-copy).
import { FFT, hannPeriodic, reflectPad, demucsMag, demucsIstftChannel, DEMUCS_BINS } from "./fft";

const NFFT = 4096;
const HOP = 1024;
const BINS = NFFT / 2 + 1; // 2049
const MODEL_SR = 44100;
const CHUNK_SEC = 8;
const OVERLAP_SEC = 0.75;
const TARGETS = ["vocals", "drums", "bass", "other"] as const;
type Target = (typeof TARGETS)[number];

const fft = new FFT(NFFT);
const WIN = hannPeriodic(NFFT);

// ---- onnxruntime-web (CDN), inside the worker --------------------------------
// 1.22.0, NOT 1.20.1: the 1.20 WebGPU EP miscomputes the demucs freq branch
// (Conv2d/InstanceNorm/ConvTranspose2d) → garbage spectrogram stems. Fixed in 1.21+
// (verified maxErr 3e-6 vs PyTorch). Open-Unmix (wasm EP) is unaffected by the bump.
const ORT_VER = "1.22.0";
const ORT_CDN = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VER}/dist/ort.webgpu.min.mjs`;
/* eslint-disable @typescript-eslint/no-explicit-any */
let ortPromise: Promise<any> | null = null;
function loadOrt(threads: number): Promise<any> {
  if (!ortPromise) {
    ortPromise = (async () => {
      const ort = await import(/* @vite-ignore */ ORT_CDN);
      ort.env.wasm.wasmPaths = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VER}/dist/`;
      ort.env.wasm.numThreads = Math.max(1, threads); // wasm SIMD threads (needs COI)
      return ort;
    })();
  }
  return ortPromise;
}
const sessions = new Map<string, Promise<any>>();
function getSession(ort: any, url: string, eps: string[] = ["wasm"]): Promise<any> {
  const cached = sessions.get(url);
  if (cached) return cached;
  // GPU as an option: demucs-core passes ['webgpu','wasm'] so its Conv/MatMul/attention
  // run on the GPU with per-op CPU fallback. Open-Unmix keeps ['wasm'] (it's LSTM —
  // WebGPU has no LSTM kernel, so GPU would just shuttle data and slow it down).
  const p: Promise<any> = ort.InferenceSession.create(url, { executionProviders: eps });
  sessions.set(url, p);
  return p;
}

// ---- STFT / ISTFT (bin-major: index = bin*nframes + frame) -------------------
interface Spec {
  re: Float32Array;
  im: Float32Array;
  nframes: number;
}
function stft(x: Float32Array): Spec {
  const xp = reflectPad(x, NFFT / 2);
  const nframes = 1 + Math.floor(x.length / HOP);
  const re = new Float32Array(BINS * nframes);
  const im = new Float32Array(BINS * nframes);
  const fr = new Float32Array(NFFT);
  const fi = new Float32Array(NFFT);
  for (let t = 0; t < nframes; t++) {
    const off = t * HOP;
    for (let i = 0; i < NFFT; i++) {
      fr[i] = xp[off + i] * WIN[i];
      fi[i] = 0;
    }
    fft.transform(fr, fi, false);
    for (let b = 0; b < BINS; b++) {
      re[b * nframes + t] = fr[b];
      im[b * nframes + t] = fi[b];
    }
  }
  return { re, im, nframes };
}
function istft(re: Float32Array, im: Float32Array, nframes: number, outLen: number): Float32Array {
  const pad = NFFT / 2;
  const full = (nframes - 1) * HOP + NFFT;
  const y = new Float32Array(full);
  const ws = new Float32Array(full);
  const fr = new Float32Array(NFFT);
  const fi = new Float32Array(NFFT);
  for (let t = 0; t < nframes; t++) {
    for (let b = 0; b < BINS; b++) {
      fr[b] = re[b * nframes + t];
      fi[b] = im[b * nframes + t];
    }
    for (let b = 1; b < NFFT / 2; b++) {
      fr[NFFT - b] = re[b * nframes + t];
      fi[NFFT - b] = -im[b * nframes + t];
    }
    fft.transform(fr, fi, true);
    const off = t * HOP;
    for (let i = 0; i < NFFT; i++) {
      y[off + i] += fr[i] * WIN[i];
      ws[off + i] += WIN[i] * WIN[i];
    }
  }
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const d = ws[pad + i];
    out[i] = d > 1e-8 ? y[pad + i] / d : 0;
  }
  return out;
}

async function separateChunk(
  ort: any,
  urls: Record<string, string>,
  ch: Float32Array[],
): Promise<Record<Target, Float32Array[]>> {
  const specs = ch.map(stft);
  const nframes = specs[0].nframes;
  const stride = BINS * nframes;
  const mag = new Float32Array(2 * stride);
  for (let c = 0; c < 2; c++) {
    const s = specs[c];
    const base = c * stride;
    for (let k = 0; k < stride; k++) mag[base + k] = Math.hypot(s.re[k], s.im[k]);
  }

  const ests: Record<string, Float32Array> = {};
  for (const t of TARGETS) {
    const sess = await getSession(ort, urls[t]);
    const res = await sess.run({ mag: new ort.Tensor("float32", mag, [1, 2, BINS, nframes]) });
    ests[t] = res.est.data as Float32Array;
  }

  const denom = new Float32Array(2 * stride);
  for (const t of TARGETS) {
    const e = ests[t];
    for (let k = 0; k < denom.length; k++) denom[k] += e[k] * e[k];
  }
  for (let k = 0; k < denom.length; k++) denom[k] += 1e-10;

  const out = {} as Record<Target, Float32Array[]>;
  const outLen = ch[0].length;
  for (const t of TARGETS) {
    const est = ests[t];
    const chans: Float32Array[] = [];
    for (let c = 0; c < 2; c++) {
      const base = c * stride;
      const mre = new Float32Array(stride);
      const mim = new Float32Array(stride);
      for (let k = 0; k < stride; k++) {
        const e = est[base + k];
        const mask = (e * e) / denom[base + k];
        mre[k] = mask * specs[c].re[k];
        mim[k] = mask * specs[c].im[k];
      }
      chans.push(istft(mre, mim, nframes, outLen));
    }
    out[t] = chans;
  }
  return out;
}

type Post = (pct: number) => void;

// --- Open-Unmix arch: magnitude STFT → mask → ISTFT, chunked + crossfaded ------
async function runOpenUnmix(
  ort: any,
  urls: Record<string, string>,
  full: Float32Array[],
  N: number,
  post: Post,
): Promise<Record<Target, Float32Array[]>> {
  const chunk = CHUNK_SEC * MODEL_SR;
  const overlap = Math.round(OVERLAP_SEC * MODEL_SR);
  const hop = chunk - overlap;
  const nchunks = N <= chunk ? 1 : Math.ceil((N - overlap) / hop);
  const acc: Record<Target, Float32Array[]> = {} as never;
  for (const t of TARGETS) acc[t] = [new Float32Array(N), new Float32Array(N)];

  for (let ci = 0; ci < nchunks; ci++) {
    const start = ci * hop;
    const end = Math.min(N, start + chunk);
    let stems: Record<Target, Float32Array[]> | null = await separateChunk(ort, urls, [
      full[0].slice(start, end),
      full[1].slice(start, end),
    ]);
    const segLen = end - start;
    for (const t of TARGETS) {
      for (let c = 0; c < 2; c++) {
        const dst = acc[t][c];
        const src = stems[t][c];
        for (let i = 0; i < segLen; i++) {
          let w = 1;
          if (ci > 0 && i < overlap) w = i / overlap;
          else if (end < N && i >= segLen - overlap) w = (segLen - i) / overlap;
          dst[start + i] += src[i] * w;
        }
      }
    }
    stems = null;
    post((ci + 1) / nchunks);
    await new Promise((r) => setTimeout(r, 0));
  }
  return acc;
}

// --- Demucs arch: single waveform model. Fixed 7.8s segments, triangular-window
// overlap-add (matches demucs-onnx). Output is [1,4,2,N] in source order
// drums,bass,other,vocals — same names as TARGETS, so no index remap. -----------
const DEMUCS_SEG = 343980; // round(7.8 * 44100), the graph is hard-bound to this
const DEMUCS_SOURCES = ["drums", "bass", "other", "vocals"] as const;
function transitionWindow(seg: number, overlap: number): Float32Array {
  const w = new Float32Array(seg).fill(1);
  for (let i = 0; i < overlap; i++) {
    const v = i / overlap;
    w[i] = v;
    w[seg - 1 - i] = v;
  }
  return w;
}
async function runDemucs(
  ort: any,
  url: string,
  full: Float32Array[],
  N: number,
  post: Post,
): Promise<Record<Target, Float32Array[]>> {
  const seg = DEMUCS_SEG;
  const overlap = Math.floor(seg / 4);
  const stride = seg - overlap;
  const sess = await getSession(ort, url);
  const win = transitionWindow(seg, overlap);
  const acc: Record<Target, Float32Array[]> = {} as never;
  for (const t of TARGETS) acc[t] = [new Float32Array(N), new Float32Array(N)];
  const weight = new Float32Array(N);
  const nchunks = Math.max(1, Math.ceil(N / stride));
  const chunkBuf = new Float32Array(2 * seg);

  for (let ci = 0; ci < nchunks; ci++) {
    const start = ci * stride;
    const end = Math.min(start + seg, N);
    const segLen = end - start;
    chunkBuf.fill(0);
    for (let c = 0; c < 2; c++) chunkBuf.subarray(c * seg, c * seg + segLen).set(full[c].subarray(start, end));
    const res = await sess.run({ mix: new ort.Tensor("float32", chunkBuf, [1, 2, seg]) });
    const stems = res.stems.data as Float32Array; // [1,4,2,seg]
    for (let si = 0; si < DEMUCS_SOURCES.length; si++) {
      const t = DEMUCS_SOURCES[si] as Target;
      for (let c = 0; c < 2; c++) {
        const rowStart = (si * 2 + c) * seg;
        const dst = acc[t][c];
        for (let s = 0; s < segLen; s++) dst[start + s] += stems[rowStart + s] * win[s];
      }
    }
    for (let s = 0; s < segLen; s++) weight[start + s] += win[s];
    post((ci + 1) / nchunks);
    await new Promise((r) => setTimeout(r, 0));
  }
  for (const t of TARGETS) {
    for (let c = 0; c < 2; c++) {
      const a = acc[t][c];
      for (let s = 0; s < N; s++) a[s] /= Math.max(weight[s], 1e-8);
    }
  }
  return acc;
}

// --- Demucs CORE arch: the spectrogram-in ONNX (STFT/iSTFT in JS), run on the
// WebGPU EP. The graph is the lean demucs body (1528 nodes — no in-graph STFT), so
// ORT's WebGPU kernels run it at ~1s per 7.8s segment. STFT/CaC/iSTFT/combine here
// are bit-exact vs PyTorch (see fft.ts). Output: freq_out [1,4,4,BINS,F] (CaC) +
// time_out [1,4,2,seg]; final stem = time_out + iSTFT(freq_out). ------------------
async function runDemucsCore(
  ort: any,
  url: string,
  full: Float32Array[],
  N: number,
  post: Post,
  eps: string[] = ["webgpu", "wasm"],
): Promise<Record<Target, Float32Array[]>> {
  const seg = DEMUCS_SEG;
  const overlap = Math.floor(seg / 4);
  const stride = seg - overlap;
  // GPU variant → ["webgpu","wasm"] (default); CPU variant → ["wasm"] (stable on
  // iOS, no JSEP crash) — same graph + same stems, only the backend differs.
  const sess = await getSession(ort, url, eps);
  const win = transitionWindow(seg, overlap);
  const acc: Record<Target, Float32Array[]> = {} as never;
  for (const t of TARGETS) acc[t] = [new Float32Array(N), new Float32Array(N)];
  const weight = new Float32Array(N);
  const nchunks = Math.max(1, Math.ceil(N / stride));
  const Lbuf = new Float32Array(seg);
  const Rbuf = new Float32Array(seg);
  const mixBuf = new Float32Array(2 * seg);

  for (let ci = 0; ci < nchunks; ci++) {
    const start = ci * stride;
    const end = Math.min(start + seg, N);
    const segLen = end - start;
    Lbuf.fill(0);
    Rbuf.fill(0);
    Lbuf.set(full[0].subarray(start, end));
    Rbuf.set(full[1].subarray(start, end));

    const { mag, frames } = demucsMag(fft, Lbuf, Rbuf);
    mixBuf.set(Lbuf, 0);
    mixBuf.set(Rbuf, seg);

    const res = await sess.run({
      mag: new ort.Tensor("float32", mag, [1, 4, DEMUCS_BINS, frames]),
      mix: new ort.Tensor("float32", mixBuf, [1, 2, seg]),
    });
    const fo = res.freq_out.data as Float32Array; // [1,4,4,BINS,frames]
    const to = res.time_out.data as Float32Array; // [1,4,2,seg]
    const chStride = DEMUCS_BINS * frames;

    for (let si = 0; si < DEMUCS_SOURCES.length; si++) {
      const t = DEMUCS_SOURCES[si] as Target;
      const fb = si * 4 * chStride; // [L_re, L_im, R_re, R_im]
      const fL = demucsIstftChannel(fft, fo.subarray(fb, fb + chStride), fo.subarray(fb + chStride, fb + 2 * chStride), frames, seg);
      const fR = demucsIstftChannel(fft, fo.subarray(fb + 2 * chStride, fb + 3 * chStride), fo.subarray(fb + 3 * chStride, fb + 4 * chStride), frames, seg);
      for (let c = 0; c < 2; c++) {
        const fchan = c === 0 ? fL : fR;
        const tb = (si * 2 + c) * seg;
        const dst = acc[t][c];
        for (let s = 0; s < segLen; s++) dst[start + s] += (to[tb + s] + fchan[s]) * win[s];
      }
    }
    for (let s = 0; s < segLen; s++) weight[start + s] += win[s];
    post((ci + 1) / nchunks);
    await new Promise((r) => setTimeout(r, 0));
  }
  for (const t of TARGETS) {
    for (let c = 0; c < 2; c++) {
      const a = acc[t][c];
      for (let s = 0; s < N; s++) a[s] /= Math.max(weight[s], 1e-8);
    }
  }
  return acc;
}

interface SeparateMsg {
  type: "separate";
  id: number;
  l: ArrayBuffer;
  r: ArrayBuffer;
  frames: number;
  arch: string;
  urls?: Record<string, string>;
  url?: string;
  eps?: string[]; // demucs-core EP override: GPU → default ["webgpu","wasm"], CPU → ["wasm"]
  threads: number;
}

self.onmessage = async (e: MessageEvent<SeparateMsg>) => {
  const msg = e.data;
  if (msg.type !== "separate") return;
  const { id, threads } = msg;
  try {
    const ort = await loadOrt(threads);
    const full = [new Float32Array(msg.l), new Float32Array(msg.r)];
    const N = msg.frames;
    const post: Post = (pct) => self.postMessage({ type: "progress", id, pct });

    const acc =
      msg.arch === "demucs-core"
        ? await runDemucsCore(ort, msg.url!, full, N, post, msg.eps)
        : msg.arch === "demucs"
          ? await runDemucs(ort, msg.url!, full, N, post)
          : await runOpenUnmix(ort, msg.urls!, full, N, post);

    const transfer: ArrayBuffer[] = [];
    const stems: Record<string, ArrayBuffer[]> = {};
    for (const t of TARGETS) {
      const lb = acc[t][0].buffer as ArrayBuffer;
      const rb = acc[t][1].buffer as ArrayBuffer;
      stems[t] = [lb, rb];
      transfer.push(lb, rb);
    }
    self.postMessage({ type: "done", id, stems }, transfer);
  } catch (err) {
    self.postMessage({ type: "error", id, message: String((err as Error)?.message ?? err) });
  }
};
