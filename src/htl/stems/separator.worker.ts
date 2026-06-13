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

// Pause between segments. On the WebGPU path the GPU is otherwise saturated back-to-
// back and the browser compositor (same GPU) can't paint → the deck/UI stutters; a
// ~frame gap lets it idle and render between submissions. Cheap vs the per-segment
// compute (~1 s GPU / multi-s CPU), so smoothness wins. Keeps playback + controls
// primary, as asked.
const SEGMENT_YIELD_MS = 12;
const yieldSegment = () => new Promise((r) => setTimeout(r, SEGMENT_YIELD_MS));

const fft = new FFT(NFFT);
const WIN = hannPeriodic(NFFT);

// ---- onnxruntime-web (CDN), inside the worker --------------------------------
// 1.22.0, NOT 1.20.1: the 1.20 WebGPU EP miscomputes the demucs freq branch
// (Conv2d/InstanceNorm/ConvTranspose2d) → garbage spectrogram stems. Fixed in 1.21+
// (verified maxErr 3e-6 vs PyTorch). Open-Unmix (wasm EP) is unaffected by the bump.
const ORT_VER = "1.22.0";
const ORT_BASE = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VER}/dist/`;
// We only drive the WebGPU (JSEP) execution provider on CHROMIUM. Outside it, JSEP is
// unreliable: on Safari/WebKit the JSEP build triggers a severe JSC wasm-compile leak
// (onnxruntime#26827 — CPU pegs, memory climbs past 10 GB, the tab is killed; still
// unfixed), and Firefox's WebGPU device-losts under heavy compute. So on non-Chromium
// we load the PLAIN-WASM bundle (no JSEP at all → the leak can't happen) and run demucs
// on the CPU EP: slower, but stable. On an Apple-Silicon Mac this means Chrome → Metal-
// backed WebGPU (fast), Safari → multi-threaded wasm SIMD (stable). The worker has its
// own `navigator`, so the UA check here matches the main thread's `isChromium()`.
const UA = (typeof navigator !== "undefined" && navigator.userAgent) || "";
const USE_WEBGPU = /Chrome\/|Chromium\//.test(UA); // Chromium family only (incl. new Edge/Brave/Opera)
const ORT_CDN = `${ORT_BASE}${USE_WEBGPU ? "ort.webgpu.min.mjs" : "ort.wasm.min.mjs"}`;
/* eslint-disable @typescript-eslint/no-explicit-any */
let ortPromise: Promise<any> | null = null;
function loadOrt(threads: number): Promise<any> {
  if (!ortPromise) {
    ortPromise = (async () => {
      const ort = await import(/* @vite-ignore */ ORT_CDN);
      ort.env.wasm.wasmPaths = ORT_BASE;
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
    await yieldSegment();
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
    await yieldSegment();
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
interface DemucsQuality {
  shifts: number; // random-shift TTA passes averaged (0 = single aligned pass)
  overlap: number; // segment overlap fraction (0..0.5) — higher = smoother seams
}

// One aligned demucs-core pass over `full` (length N). 7.8s segments, triangular
// overlap-add at `overlapFrac`. Raising overlap averages more segment passes per
// sample (smoother seams, fewer transient smears) at ~1/(1-overlap)× the segment
// count. Factored out so shift-TTA can run it on randomly-delayed copies.
async function demucsCorePass(
  ort: any,
  sess: any,
  full: Float32Array[],
  N: number,
  overlapFrac: number,
  post: Post,
): Promise<Record<Target, Float32Array[]>> {
  const seg = DEMUCS_SEG;
  const overlap = Math.min(seg >> 1, Math.max(0, Math.floor(seg * overlapFrac)));
  const stride = seg - overlap;
  const win = transitionWindow(seg, overlap);
  const acc: Record<Target, Float32Array[]> = {} as never;
  for (const t of TARGETS) acc[t] = [new Float32Array(N), new Float32Array(N)];
  const weight = new Float32Array(N);
  const nchunks = Math.max(1, Math.ceil(N / stride));
  // Prepare ONE segment's inputs (CPU STFT) and immediately launch its GPU run. Each call
  // allocates its OWN Lbuf/Rbuf/mixBuf/mag — no shared/reused buffers — so a segment that's still
  // uploading to the GPU can't be clobbered by the next segment's prep (the async-upload race).
  const prep = (ci: number) => {
    const start = ci * stride;
    const end = Math.min(start + seg, N);
    const Lbuf = new Float32Array(seg); // zero-padded tail for the last (short) segment
    const Rbuf = new Float32Array(seg);
    Lbuf.set(full[0].subarray(start, end));
    Rbuf.set(full[1].subarray(start, end));
    const { mag, frames } = demucsMag(fft, Lbuf, Rbuf);
    const mixBuf = new Float32Array(2 * seg);
    mixBuf.set(Lbuf, 0);
    mixBuf.set(Rbuf, seg);
    const magT = new ort.Tensor("float32", mag, [1, 4, DEMUCS_BINS, frames]);
    const mixT = new ort.Tensor("float32", mixBuf, [1, 2, seg]);
    return { start, segLen: end - start, frames, magT, mixT, run: sess.run({ mag: magT, mix: mixT }) };
  };

  // PIPELINE: launch segment ci+1's GPU run BEFORE doing ci's CPU iSTFT/overlap-add, so the GPU
  // chews the next segment while the CPU finishes the current one — instead of the GPU idling
  // through every iSTFT (the dominant dip in the sawtooth). Pure SCHEDULING: same STFT, same
  // sess.run, same OLA accumulation keyed by `start`/`win` → bit-identical output. The 12 ms
  // yield stays so the compositor still paints, now overlapped with useful GPU work.
  let cur = prep(0);
  for (let ci = 0; ci < nchunks; ci++) {
    const { start, segLen, frames, magT, mixT, run } = cur;
    const res = await run;
    const next = ci + 1 < nchunks ? prep(ci + 1) : null; // GPU starts ci+1 now → overlaps the CPU below
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
    // Free this segment's tensors NOW (fo/to already read into acc) instead of waiting for GC. On
    // the WebGPU EP each run otherwise leaves the input upload + output staging GPUBuffers live —
    // across a 30-segment track that pressure builds (unified memory). ORT ≥1.16 has dispose.
    magT.dispose?.();
    mixT.dispose?.();
    res.freq_out.dispose?.();
    res.time_out.dispose?.();
    for (let s = 0; s < segLen; s++) weight[start + s] += win[s];
    post((ci + 1) / nchunks);
    if (next) {
      cur = next;
      await yieldSegment(); // compositor paints here while the GPU works the next segment
    }
  }
  for (const t of TARGETS) {
    for (let c = 0; c < 2; c++) {
      const a = acc[t][c];
      for (let s = 0; s < N; s++) a[s] /= Math.max(weight[s], 1e-8);
    }
  }
  return acc;
}

// demucs-core entry. Without shifts → a single aligned pass (the original, lightest
// path). With `shifts` → demucs `--shifts` test-time augmentation: average N passes,
// each on the mix delayed by a random offset ≤ MAX_SHIFT then realigned back. This
// is the single biggest perceptual artifact reducer and a pure GPU-time-for-quality
// trade (≈shifts× cost) — desktop GPU only. We DELAY (not advance) and size the work
// buffer to N+MAX_SHIFT so every realigned output sample is covered: no degraded tail
// at the track end (matches demucs' 2·max_shift padding).
async function runDemucsCore(
  ort: any,
  url: string,
  full: Float32Array[],
  N: number,
  post: Post,
  eps: string[] = ["webgpu", "wasm"],
  quality: DemucsQuality = { shifts: 0, overlap: 0.25 },
): Promise<Record<Target, Float32Array[]>> {
  // GPU variant → ["webgpu","wasm"] (default); CPU variant → ["wasm"] (stable on
  // iOS, no JSEP crash) — same graph + same stems, only the backend differs. Outside
  // Chromium we loaded the wasm-only bundle (see ORT_CDN), which has no WebGPU EP, so
  // force the wasm EP rather than asking for an absent one.
  const sess = await getSession(ort, url, USE_WEBGPU ? eps : ["wasm"]);
  const overlapFrac = Math.min(0.5, Math.max(0, quality.overlap));
  const shifts = Math.max(0, quality.shifts | 0);
  if (shifts < 1) return demucsCorePass(ort, sess, full, N, overlapFrac, post);

  const MAX_SHIFT = Math.round(0.5 * MODEL_SR); // demucs uses 0.5s
  const N2 = N + MAX_SHIFT;
  const out: Record<Target, Float32Array[]> = {} as never;
  for (const t of TARGETS) out[t] = [new Float32Array(N), new Float32Array(N)];
  for (let sh = 0; sh < shifts; sh++) {
    const offset = Math.floor(Math.random() * (MAX_SHIFT + 1)); // [0, MAX_SHIFT]
    const delayed = [new Float32Array(N2), new Float32Array(N2)];
    delayed[0].set(full[0], offset); // zeros[0,offset) then the mix → a pure delay
    delayed[1].set(full[1], offset);
    const pass = await demucsCorePass(ort, sess, delayed, N2, overlapFrac, (p) => post((sh + p) / shifts));
    for (const t of TARGETS) {
      for (let c = 0; c < 2; c++) {
        const dst = out[t][c];
        const src = pass[t][c]; // realign: drop the `offset` samples we delayed by
        for (let i = 0; i < N; i++) dst[i] += src[i + offset];
      }
    }
  }
  const inv = 1 / shifts;
  for (const t of TARGETS) {
    for (let c = 0; c < 2; c++) {
      const a = out[t][c];
      for (let i = 0; i < N; i++) a[i] *= inv;
    }
  }
  return out;
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
  quality?: DemucsQuality; // demucs-core shift-TTA + overlap (desktop quality knobs)
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
        ? await runDemucsCore(ort, msg.url!, full, N, post, msg.eps, msg.quality)
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
