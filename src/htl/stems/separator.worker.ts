/// <reference lib="webworker" />
// Stem-separation worker: the ENTIRE heavy pipeline (JS STFT → the demucs core on
// ORT → JS iSTFT + combine) runs here, off the main thread, so the app stays
// responsive while a track separates. The main thread only resamples to/from
// 44.1 kHz (async, cheap) and ships planar Float32 channels in/out as transferables
// (zero-copy). Demucs is the ONLY separator — Open-Unmix and the demucs-rs wasm
// engine were ripped (the project settled on one engine).
import { FFT, demucsMag, demucsIstftChannel, DEMUCS_BINS } from "./fft";

const NFFT = 4096;
const MODEL_SR = 44100;
const TARGETS = ["vocals", "drums", "bass", "other"] as const;
type Target = (typeof TARGETS)[number];

// Pause between segments. On the WebGPU path the GPU is otherwise saturated back-to-
// back and the browser compositor (same GPU) can't paint → the deck/UI stutters; a
// ~frame gap lets it idle and render between submissions. Cheap vs the per-segment
// compute (~1 s GPU / multi-s CPU), so smoothness wins. Keeps playback + controls
// primary, as asked.
const SEGMENT_YIELD_MS = 16; // ~one frame, so the compositor gets a full paint slot per segment
const yieldSegment = () => new Promise((r) => setTimeout(r, SEGMENT_YIELD_MS));

const fft = new FFT(NFFT);

type Post = (pct: number) => void;

// ---- onnxruntime-web (CDN), inside the worker --------------------------------
// 1.22.0, NOT 1.20.1: the 1.20 WebGPU EP miscomputes the demucs freq branch
// (Conv2d/InstanceNorm/ConvTranspose2d) → garbage spectrogram stems. Fixed in 1.21+
// (verified maxErr 3e-6 vs PyTorch). Open-Unmix (wasm EP) is unaffected by the bump.
// Self-hosted (SAME-ORIGIN) — onnxruntime-web 1.22.0 vendored into public/ort/ at build
// time and hash-pinned (see vite.config.ts `ortVendor`). NOT a third-party CDN: the browser
// never trusts an external host at runtime, and same-origin satisfies COEP without any CORS
// dance. Bump the version in vite.config.ts (path + hashes) when upgrading.
const ORT_BASE = `/ort/`;
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
// Use an ABSOLUTE origin URL, not a bare `/ort/…` path: the vite DEV server's import-analysis
// resolves a root-relative import to a source-module id, finds it under /public, and refuses it
// ("this file is in /public … should not be imported from source code" overlay). An absolute URL is
// treated as external → served statically, so dev works. Prod is unaffected (the worker's own origin
// already serves /ort/ from the dist root, so this resolves to the same file).
const ORT_ORIGIN = (typeof self !== "undefined" && self.location?.origin) || "";
const ORT_CDN = `${ORT_ORIGIN}${ORT_BASE}${USE_WEBGPU ? "ort.webgpu.min.mjs" : "ort.wasm.min.mjs"}`;
/* eslint-disable @typescript-eslint/no-explicit-any */
let ortPromise: Promise<any> | null = null;
function loadOrt(threads: number): Promise<any> {
  if (!ortPromise) {
    ortPromise = (async () => {
      const ort = await import(/* @vite-ignore */ ORT_CDN);
      ort.env.wasm.wasmPaths = ORT_BASE;
      ort.env.wasm.numThreads = Math.max(1, threads); // wasm SIMD threads (needs COI)
      // Hand ORT a WebGPU device with the WGSL `shader-f16` feature ENABLED, so an fp16 model's
      // generated f16 shaders (e.g. `array<vec4<f16>>` in the Cast/Sub kernels) actually compile.
      // ORT-web otherwise creates the device WITHOUT extra features → "'f16' type used without
      // 'f16' extension enabled" → the Cast pipeline is invalid → cascade → garbage/noise stems.
      // THIS — a forgotten device feature, not broken kernels — is what the old "ORT miscomputes
      // f16" folklore actually was. We request the adapter's MAX limits too so the fp32 path (large
      // demucs storage buffers) is unaffected by supplying our own device. Best-effort: any failure
      // (no shader-f16 support, request rejected) leaves ORT to make its own device → fp32 still works,
      // fp16 just won't compile on that GPU (then the self-check / ear-test shows it).
      if (USE_WEBGPU) {
        try {
          const gpu: any = (navigator as any).gpu;
          // Belt: if our own device request below fails, ORT's self-created adapter should
          // still ask for the DISCRETE GPU — the default request on a dual-GPU machine
          // returns the integrated one.
          ort.env.webgpu.powerPreference = "high-performance";
          const adapter = gpu && (await gpu.requestAdapter({ powerPreference: "high-performance" }));
          // ★ Hand ORT OUR device WHENEVER we got an adapter — not only in the f16 case.
          // This code used to bail unless the adapter exposed shader-f16, which meant on
          // exactly the machines where f16 lags (Linux+NVIDIA Chrome) ORT silently created
          // its own DEFAULT adapter — the integrated GPU on a dual-GPU box — and every
          // "GPU" separation quietly ran ~severalfold slower on the wrong silicon. Found
          // by the operator watching the wrong GPU light up during the CPU-bench session.
          if (adapter) {
            const lim: any = adapter.limits;
            const want = [
              "maxStorageBufferBindingSize", "maxBufferSize", "maxStorageBuffersPerShaderStage",
              "maxUniformBufferBindingSize", "maxComputeWorkgroupStorageSize", "maxComputeInvocationsPerWorkgroup",
              "maxComputeWorkgroupSizeX", "maxComputeWorkgroupSizeY", "maxComputeWorkgroupSizeZ",
              "maxComputeWorkgroupsPerDimension",
            ];
            const requiredLimits: Record<string, number> = {};
            for (const k of want) if (typeof lim?.[k] === "number") requiredLimits[k] = lim[k]; // adapter max → ≥ ORT's needs
            // shader-f16 only where the adapter has it (the fp16 model's enabler); fp32 needs no feature.
            const requiredFeatures: string[] = adapter.features?.has?.("shader-f16") ? ["shader-f16"] : [];
            ort.env.webgpu.device = await adapter.requestDevice({ requiredFeatures, requiredLimits });
          }
        } catch {
          /* keep ORT's own device — fp32 unaffected; fp16 just can't compile here */
        }
      }
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


// --- Demucs-core constants: fixed 7.8s segments, triangular-window overlap-add
// (matches demucs-onnx). Sources in graph order drums,bass,other,vocals — same
// names as TARGETS, so no index remap. -------------------------------------------
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

  // SCHEDULING for UI smoothness over raw throughput (playback + controls are primary, as
  // asked). We deliberately do NOT pipeline the next GPU run ahead of this segment's CPU
  // iSTFT: pinning the GPU continuously starved the browser compositor (same GPU) for the
  // whole separation → the deck/UI froze, and the worker's back-to-back CPU work crowded the
  // audio thread → playback lag. Instead, each segment runs the GPU, then does the CPU
  // iSTFT/OLA (GPU now IDLE → compositor can paint), then yields a frame with BOTH the GPU
  // and the worker CPU idle, THEN launches the next run. Output is unchanged (pure ordering).
  // Cost: the GPU idles through each iSTFT (the sawtooth dip) — that idle IS what keeps the
  // UI alive. For headless/idle-deck separation, relaunch-ahead pipelining would be faster.
  let cur = prep(0);
  for (let ci = 0; ci < nchunks; ci++) {
    const { start, segLen, frames, magT, mixT, run } = cur;
    const res = await run;
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
    // Yield a frame with the GPU + worker CPU IDLE so the compositor paints and the audio
    // thread gets a core, THEN launch the next segment's GPU run. (Tried relaunch-ahead
    // pipelining on discrete GPUs for speed, but pinning the GPU continuously starved the
    // browser compositor — same GPU — and the deck waveform/playhead went visibly laggy. On
    // a single shared GPU the per-segment GPU-idle here IS what keeps the UI smooth.)
    if (ci + 1 < nchunks) {
      await yieldSegment();
      cur = prep(ci + 1);
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

// fp16 A/B self-check: run ONE representative (middle) segment through the fp16 session AND
// the fp32 reference on the SAME WebGPU EP, then report the max/RMS error between their raw
// model outputs (time_out + freq_out, BEFORE the JS iSTFT — so this measures the f16 kernels
// directly). relTime = maxErr / fp32-peak: ~0 = correct, ~1 = garbage (the "ORT miscomputes
// f16" claim). Best-effort: any throw (e.g. an f16-I/O type mismatch, or the ref failing to
// load) is reported and never breaks the real separation. Runs once, then the fp16 pass
// proceeds normally regardless of the verdict — the user judges by ear too.
async function f16SelfCheck(ort: any, f16Sess: any, refUrl: string, full: Float32Array[], N: number): Promise<void> {
  const seg = DEMUCS_SEG;
  const start = Math.max(0, Math.min(N - seg, (N - seg) >> 1)); // a middle segment (real content, not the silent head/tail)
  const Lbuf = new Float32Array(seg);
  const Rbuf = new Float32Array(seg);
  const end = Math.min(start + seg, N);
  Lbuf.set(full[0].subarray(start, end));
  Rbuf.set(full[1].subarray(start, end));
  const { mag, frames } = demucsMag(fft, Lbuf, Rbuf);
  const mixBuf = new Float32Array(2 * seg);
  mixBuf.set(Lbuf, 0);
  mixBuf.set(Rbuf, seg);
  // Fresh tensors per run (the WebGPU EP detaches the upload buffer — can't share, see prep()).
  const inputs = () => ({
    mag: new ort.Tensor("float32", mag.slice(), [1, 4, DEMUCS_BINS, frames]),
    mix: new ort.Tensor("float32", mixBuf.slice(), [1, 2, seg]),
  });
  const a = await f16Sess.run(inputs()); // fp16 (already loaded)
  const refSess = await getSession(ort, refUrl, ["webgpu", "wasm"]); // fp32 reference
  const b = await refSess.run(inputs());
  const stat = (x: Float32Array, y: Float32Array) => {
    const n = Math.min(x.length, y.length);
    let mx = 0, se = 0;
    for (let i = 0; i < n; i++) { const d = Math.abs(x[i] - y[i]); if (d > mx) mx = d; se += d * d; }
    return { maxErr: mx, rms: Math.sqrt(se / n) };
  };
  const refT = b.time_out.data as Float32Array;
  let peak = 0;
  for (let i = 0; i < refT.length; i++) { const v = Math.abs(refT[i]); if (v > peak) peak = v; }
  const t = stat(a.time_out.data as Float32Array, refT);
  const f = stat(a.freq_out.data as Float32Array, b.freq_out.data as Float32Array);
  self.postMessage({
    type: "f16check", peak,
    maxErrTime: t.maxErr, rmsTime: t.rms, relTime: peak ? t.maxErr / peak : 0,
    maxErrFreq: f.maxErr, rmsFreq: f.rms,
  });
  a.time_out.dispose?.(); a.freq_out.dispose?.();
  b.time_out.dispose?.(); b.freq_out.dispose?.();
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
  selfCheck = false,
  refUrl?: string,
): Promise<Record<Target, Float32Array[]>> {
  // GPU variant → ["webgpu","wasm"] (default); CPU variant → ["wasm"] (stable on
  // iOS, no JSEP crash) — same graph + same stems, only the backend differs. Outside
  // Chromium we loaded the wasm-only bundle (see ORT_CDN), which has no WebGPU EP, so
  // force the wasm EP rather than asking for an absent one.
  const sess = await getSession(ort, url, USE_WEBGPU ? eps : ["wasm"]);
  // fp16 A/B: before the real pass, compare ONE segment fp16-vs-fp32 on WebGPU (best-effort).
  if (selfCheck && refUrl && USE_WEBGPU) {
    await f16SelfCheck(ort, sess, refUrl, full, N).catch((e) =>
      self.postMessage({ type: "f16check", error: String((e as Error)?.message ?? e) }),
    );
  }
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
  url: string;
  quality?: DemucsQuality; // demucs-core shift-TTA + overlap (desktop quality knobs)
  selfCheck?: boolean; // fp16 model: numerically compare ONE segment vs the fp32 refUrl on WebGPU
  refUrl?: string; // fp32 reference model URL for the fp16 self-check
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

    // ONE architecture lives here now: the demucs core. Open-Unmix and the whole-model
    // demucs export were ripped with the rest of the retired separators (the onnx rip).
    const acc = await runDemucsCore(ort, msg.url, full, N, post, undefined, msg.quality, msg.selfCheck, msg.refUrl);

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
