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
// 1.27.0's native WebGPU EP (asyncify build), NOT 1.22.0's JSEP build: same htdemucs-core
// graph runs real C++ WebGPU kernels (Conv/InstanceNorm/ConvTranspose2d etc.) instead of
// JSEP's JS-bridge kernels — ~2x faster per segment on identical hardware, confirmed via a
// 24-segment device benchmark before this switch (467-503ms/segment vs the 1.22.0 JSEP
// build's ~1s/segment). Numerically unaffected: 1.20's WebGPU freq-branch bug (Conv2d/
// InstanceNorm/ConvTranspose2d miscompute) was already fixed by 1.21+ and stays fixed here.
// Self-hosted (SAME-ORIGIN) — vendored into public/ort/ at build time and hash-pinned (see
// vite.config.ts `ortVendor`). NOT a third-party CDN: the browser never trusts an external
// host at runtime, and same-origin satisfies COEP without any CORS dance. Bump the version
// in vite.config.ts (path + hashes) when upgrading.
const ORT_BASE = `/ort/`;
// Separation is CHROMIUM + WebGPU ONLY — modelSupport/canSeparate gate every entry
// point, so this worker never runs anywhere else. There is deliberately NO fallback
// bundle and NO CPU EP route: the CPU path was benched and killed ("this is gpu
// parallel work"), and on Safari/WebKit the JSEP build triggers a severe JSC
// wasm-compile leak anyway (onnxruntime#26827). Non-Chromium browsers and phones
// consume the shared cache instead.
// Use an ABSOLUTE origin URL, not a bare `/ort/…` path: the vite DEV server's import-analysis
// resolves a root-relative import to a source-module id, finds it under /public, and refuses it
// ("this file is in /public … should not be imported from source code" overlay). An absolute URL is
// treated as external → served statically, so dev works. Prod is unaffected (the worker's own origin
// already serves /ort/ from the dist root, so this resolves to the same file).
const ORT_ORIGIN = (typeof self !== "undefined" && self.location?.origin) || "";
const ORT_CDN = `${ORT_ORIGIN}${ORT_BASE}ort.webgpu.min.mjs`;
/* eslint-disable @typescript-eslint/no-explicit-any */
let ortPromise: Promise<any> | null = null;
function loadOrt(threads: number): Promise<any> {
  if (!ortPromise) {
    ortPromise = (async () => {
      const ort = await import(/* @vite-ignore */ ORT_CDN);
      // Explicit filenames, not just the base dir: the native EP's default resolution
      // doesn't reliably pick the "asyncify" variant over other wasm builds vendored
      // alongside it (found while wiring this up — a bare base dir loaded fine in
      // isolation but is fragile once other ORT variants share public/ort/).
      ort.env.wasm.wasmPaths = {
        wasm: `${ORT_BASE}ort-wasm-simd-threaded.asyncify.wasm`,
        mjs: `${ORT_BASE}ort-wasm-simd-threaded.asyncify.mjs`,
      };
      ort.env.wasm.numThreads = Math.max(1, threads); // wasm SIMD threads (needs COI)
      // ★ Hand ORT OUR device, from the HIGH-PERFORMANCE adapter. Left to itself, ORT
      // creates a default adapter — on a dual-GPU machine that's the integrated one, and
      // every "GPU" separation quietly ran severalfold slower on the wrong silicon
      // (found by the operator watching the wrong GPU light up). We request the
      // adapter's MAX limits so the large demucs storage buffers fit. Best-effort: any
      // failure leaves ORT to make its own device (with the powerPreference belt below).
      try {
        const gpu: any = (navigator as any).gpu;
        // Belt: if our own device request below fails, ORT's self-created adapter
        // should still ask for the discrete GPU.
        ort.env.webgpu.powerPreference = "high-performance";
        const adapter = gpu && (await gpu.requestAdapter({ powerPreference: "high-performance" }));
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
          ort.env.webgpu.device = await adapter.requestDevice({ requiredLimits });
        }
      } catch {
        /* keep ORT's own device */
      }
      return ort;
    })();
  }
  return ortPromise;
}
// The model download is a single ~170 MB fetch from a cross-origin CDN (HuggingFace, via
// a signed-redirect URL) — long enough to be exposed to a network blip mid-transfer (seen
// directly while wiring this up: Chrome's own network stack aborting with
// net::ERR_NETWORK_CHANGED on ANY interface up/down event system-wide — not a CORS/COEP
// block, curl fetching the identical bytes succeeded immediately). ort.InferenceSession.
// create(url, …) hands the fetch to ORT's opaque internal loader with no retry, so one blip
// on a multi-second download kills the whole separation — a latent risk under the old JSEP
// build too (same URL, same size), just never exercised by a fresh (uncached) load until
// now. A plain restart-from-scratch retry has bad odds if blips repeat faster than a full
// download completes, so this RESUMES via Range requests (confirmed supported: the CDN
// returns 206 Partial Content) instead of re-fetching all 170 MB after every blip.
async function fetchResumable(url: string, tries = 8): Promise<ArrayBuffer | null> {
  let received = 0;
  let total = -1;
  let chunks: Uint8Array[] = [];
  let lastErr: unknown;
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      const res = await fetch(url, received > 0 ? { headers: { Range: `bytes=${received}-` } } : undefined);
      if (res.status === 404 && received === 0) return null; // caller decides if a 404 is expected
      if (received > 0 && res.status === 200) {
        // Server ignored our Range header and sent the WHOLE file again instead of a 206
        // partial — discard whatever we'd buffered so far and treat this as a fresh full
        // download, not more bytes to append (which would silently corrupt the assembly:
        // stale prefix + a full second copy, both undercounted against `total`).
        chunks = [];
        received = 0;
        total = -1;
      } else if (!res.ok && res.status !== 206) {
        throw new Error(`HTTP ${res.status} fetching ${url}`);
      }
      if (total < 0) {
        const len = res.headers.get("content-length");
        total = received + (len ? parseInt(len, 10) : NaN);
      }
      const reader = res.body!.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.byteLength;
      }
      if (!Number.isFinite(total) || received >= total) {
        const buf = new Uint8Array(received);
        let off = 0;
        for (const c of chunks) {
          buf.set(c, off);
          off += c.byteLength;
        }
        return buf.buffer;
      }
      throw new Error(`stream ended early: ${received}/${total} bytes`);
    } catch (e) {
      lastErr = e;
      if (attempt < tries - 1) await new Promise((r) => setTimeout(r, Math.min(4000, 400 * (attempt + 1))));
    }
  }
  throw lastErr;
}
const sessions = new Map<string, Promise<any>>();
function getSession(ort: any, url: string, eps: string[] = ["wasm"]): Promise<any> {
  const cached = sessions.get(url);
  if (cached) return cached;
  // demucs-core runs ['webgpu','wasm'] so its Conv/MatMul/attention run on the GPU
  // with per-op CPU fallback.
  const p: Promise<any> = (async () => {
    // htdemucs-core.onnx CAN ship its weights in a sibling .onnx.data file (external data,
    // keeps the graph file itself small) — the currently-deployed model doesn't (single
    // self-contained ~170 MB file), but a future re-export might, so this stays generic.
    // The 1.22.0 JSEP loader found a sibling file automatically from a relative path; the
    // 1.27.0 native-EP loader does NOT — it needs the mapping handed to it explicitly, or
    // session creation fails outright ("Module.MountedFiles is not available", confirmed
    // while wiring this up).
    const filename = url.split("/").pop() ?? "";
    const dataUrl = `${url}.data`;
    // The sidecar is a SPECULATIVE probe, not a required fetch — today's model doesn't
    // have one at all. Any outcome other than "here are the bytes" (a transient 5xx, a
    // network blip, anything that isn't the clean 404 case fetchResumable already returns
    // null for) must degrade to "no sidecar", NOT retry-and-throw: a Promise.all rejection
    // here would kill an ALREADY-SUCCEEDED model download over a file that may not even
    // exist. If a sidecar genuinely exists and this probe gives up on it, InferenceSession.
    // create below fails on its own, with a real "missing external data" error — a much
    // more honest failure than blaming network fragility for a load that actually worked.
    const [modelBytes, dataBytes] = await Promise.all([fetchResumable(url), fetchResumable(dataUrl).catch(() => null)]);
    if (!modelBytes) throw new Error(`model fetch returned 404: ${url}`);
    const opts: Record<string, unknown> = { executionProviders: eps };
    if (dataBytes) opts.externalData = [{ path: `${filename}.data`, data: new Uint8Array(dataBytes) }];
    return ort.InferenceSession.create(new Uint8Array(modelBytes), opts);
  })();
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
  quality: DemucsQuality = { shifts: 0, overlap: 0.25 },
): Promise<Record<Target, Float32Array[]>> {
  // The wasm EP here is ORT's per-OP fallback for kernels the WebGPU EP lacks — not a
  // separation route; whole-track CPU separation is dead (see ORT_CDN).
  const sess = await getSession(ort, url, ["webgpu", "wasm"]);
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
    const acc = await runDemucsCore(ort, msg.url, full, N, post, msg.quality);

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
