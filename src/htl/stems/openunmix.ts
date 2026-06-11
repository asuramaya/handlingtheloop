// In-browser Open-Unmix separation — main-thread orchestrator. The heavy pipeline
// (STFT → 4 ONNX nets → softmask → ISTFT) runs in separator.worker.ts so the app
// never stalls; here we only resample the mix to the model's 44.1 kHz, ship the
// PCM to the worker, and resample the returned stems back to the deck's rate so
// they line up sample-for-sample with the mix buffer.
import { STEM_NAMES, type Stems } from "./index";
import { type StemModel, isMobileDevice } from "./models";
import { stemTrace } from "./trace";
import { putStemBlobs, getStemBlobs, deleteStemBlobs, clearStemBlobsByPrefix } from "../persistence";

// ~MB of a stereo float32 buffer set of `n` samples × `sets` (4 stems = 4).
const mb = (n: number, sets = 1) => Math.round((n * 2 * 4 * sets) / 1e5) / 10;

const MODEL_SR = 44100;

// One long-lived worker; jobs are serialized (see separateOpenUnmix) so it only
// ever processes one track at a time.
let worker: Worker | null = null;
let jobId = 0;
interface Job {
  resolve: (stems: Record<string, ArrayBuffer[]>) => void;
  reject: (e: Error) => void;
  onProgress?: (pct: number) => void;
}
const jobs = new Map<number, Job>();

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL("./separator.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent) => {
      const { type, id } = e.data;
      const job = jobs.get(id);
      if (!job) return;
      if (type === "progress") job.onProgress?.(e.data.pct);
      else if (type === "done") {
        jobs.delete(id);
        job.resolve(e.data.stems);
      } else if (type === "error") {
        jobs.delete(id);
        job.reject(new Error(e.data.message));
      }
    };
    worker.onerror = (e) => {
      const msg = new Error(e.message || "separation worker crashed");
      for (const [id, job] of jobs) {
        jobs.delete(id);
        job.reject(msg);
      }
    };
  }
  return worker;
}

// Kill the worker to RECLAIM its wasm heap. wasm linear memory only ever GROWS — it
// never shrinks back to the OS — so after a heavy demucs window the worker holds its
// ~500 MB high-water heap for good. On a phone we must drop that before assembling
// the 424 MB output on the main thread, or the two together re-OOM. The next job
// just respawns the worker (reloads ORT + the cached model).
function terminateWorker(): void {
  if (worker) {
    try {
      worker.terminate();
    } catch {
      /* ignore */
    }
    worker = null;
  }
  jobs.clear();
}

function makeBuffer(channels: Float32Array[], sampleRate: number): AudioBuffer {
  const b = new AudioBuffer({ length: channels[0].length, sampleRate, numberOfChannels: channels.length });
  channels.forEach((c, i) => b.copyToChannel(c as Float32Array<ArrayBuffer>, i));
  return b;
}
async function resample(buf: AudioBuffer, dstRate: number, dstLen: number): Promise<AudioBuffer> {
  if (buf.sampleRate === dstRate && buf.length === dstLen) return buf;
  const oc = new OfflineAudioContext(buf.numberOfChannels, Math.max(1, dstLen), dstRate);
  const s = oc.createBufferSource();
  s.buffer = buf;
  s.connect(oc.destination);
  s.start();
  return oc.startRendering();
}

export type SeparateProgress = (pct: number) => void;

// Serialize ALL separations app-wide: one worker job at a time, so two decks / a
// dev StrictMode double-fire / a model switch can't stack work or memory.
let chain: Promise<unknown> = Promise.resolve();
export function separateOpenUnmix(mix: AudioBuffer, model: StemModel, onProgress?: SeparateProgress): Promise<Stems> {
  // On a PHONE, demucs would OOM-crash if the worker built the whole-track output
  // (4 full-length stereo float32 buffers ≈ 424 MB) in one pass. So mobile demucs
  // runs WINDOWED: the track is split into overlapping windows, each separated on
  // its own (the worker only ever holds one window's output), then crossfaded back
  // together on the main thread. Desktop / Open-Unmix keep the one-shot path.
  const windowed = isMobileDevice() && model.arch === "demucs-core";
  const inner = () => (windowed ? separateDemucsWindowed(mix, model, onProgress) : separateInner(mix, model, onProgress));
  const run = chain.then(inner, inner);
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// Post ONE separation job to the worker; resolve with the raw stem PCM (keyed by
// stem name → [L,R] ArrayBuffers at MODEL_SR). Transfers L/R in, zero-copy.
function runWorkerJob(
  L: Float32Array,
  R: Float32Array,
  model: StemModel,
  threads: number,
  onProgress?: SeparateProgress,
): Promise<Record<string, ArrayBuffer[]>> {
  const id = ++jobId;
  const w = getWorker();
  return new Promise<Record<string, ArrayBuffer[]>>((resolve, reject) => {
    jobs.set(id, { resolve, reject, onProgress });
    w.postMessage(
      { type: "separate", id, l: L.buffer, r: R.buffer, frames: L.length, arch: model.arch, urls: model.urls, url: model.url, eps: model.eps, threads },
      [L.buffer, R.buffer],
    );
  });
}

async function separateInner(mix: AudioBuffer, model: StemModel, onProgress?: SeparateProgress): Promise<Stems> {
  if (!model.urls && !model.url) throw new Error("model has no ONNX url(s)");
  // resample → 44.1k (OfflineAudioContext renders off the main thread)
  const m44 = await resample(mix, MODEL_SR, Math.round(mix.duration * MODEL_SR));
  const L = m44.getChannelData(0).slice();
  const R = (m44.numberOfChannels > 1 ? m44.getChannelData(1) : m44.getChannelData(0)).slice();
  const threads = globalThis.crossOriginIsolated ? Math.min(navigator.hardwareConcurrency || 4, 8) : 1;
  const raw = await runWorkerJob(L, R, model, threads, onProgress);
  // resample each stem back to the deck's rate/length
  const out = {} as Stems;
  for (const t of STEM_NAMES) {
    const [lb, rb] = raw[t];
    const buf44 = makeBuffer([new Float32Array(lb), new Float32Array(rb)], MODEL_SR);
    out[t] = await resample(buf44, mix.sampleRate, mix.length);
  }
  return out;
}

// Crossfade gain for window-local sample i: ramps up over the first `ov` samples
// (unless this is the first window) and down over the last `ov` (unless the last),
// 1 in the middle. With the per-sample weight-sum normalization below, overlapping
// windows blend seamlessly regardless of the exact ramps.
function winGain(i: number, len: number, ov: number, first: boolean, last: boolean): number {
  let g = 1;
  if (!first && i < ov) g = i / ov;
  if (!last && i > len - 1 - ov) g = Math.min(g, (len - 1 - i) / ov);
  return g < 0 ? 0 : g;
}

// Mobile demucs: separate the track in overlapping windows so the WORKER never holds
// the whole-track output (4×N float32 ≈ 424 MB → iPhone OOM). Each window is an
// ordinary worker job (the worker is unchanged — it just sees a short "track"); we
// crossfade the windows back together here. Peak worker memory ≈ one window's output.
let windowedRunSeq = 0;
async function separateDemucsWindowed(mix: AudioBuffer, model: StemModel, onProgress?: SeparateProgress): Promise<Stems> {
  if (!model.url) throw new Error("model has no ONNX url");
  const SR = MODEL_SR;
  stemTrace("windowed:resample", `dur=${mix.duration.toFixed(0)}s sr=${mix.sampleRate}`);
  const m44 = await resample(mix, SR, Math.round(mix.duration * SR));
  const L = m44.getChannelData(0).slice();
  const R = (m44.numberOfChannels > 1 ? m44.getChannelData(1) : m44.getChannelData(0)).slice();
  const N = L.length;
  // Fewer wasm threads on mobile (each thread costs memory); short windows + overlap.
  const threads = globalThis.crossOriginIsolated ? Math.min(navigator.hardwareConcurrency || 4, 4) : 1;
  const WIN = Math.min(N, Math.round(45 * SR)); // 45 s windows
  const OV = Math.min(WIN >> 1, Math.round(6 * SR)); // 6 s crossfade
  const step = Math.max(1, WIN - OV);
  const nwin = N <= WIN ? 1 : Math.ceil((N - OV) / step);
  const tmp = `__win:${++windowedRunSeq}:`;
  await clearStemBlobsByPrefix("__win:"); // GC any temp blobs left by a crashed run
  stemTrace("windowed:start", `N=${(N / 1e6).toFixed(2)}M win=${WIN / SR}s nwin=${nwin} thr=${threads} accMB=${mb(N, 4)} inMB=${mb(N)}`);

  // ── PHASE 1: separate each window, STREAM it to IndexedDB (disk), free it. The
  // main thread NEVER holds the 424 MB output here — only L/R + the current window
  // (~170 MB) — so it doesn't collide with the worker's ~500 MB window peak. ──
  for (let k = 0; k < nwin; k++) {
    const s = k * step;
    const e = Math.min(s + WIN, N);
    const len = e - s;
    const lw = L.slice(s, e);
    const rw = R.slice(s, e);
    stemTrace(`win ${k + 1}/${nwin}:run`, `len=${(len / SR).toFixed(0)}s winMB=${mb(len, 4)}`); // crash here ⇒ ONE window alone OOMs the worker → lower WIN
    let raw: Record<string, ArrayBuffer[]>;
    try {
      raw = await runWorkerJob(lw, rw, model, threads, (p) => onProgress?.((k + Math.max(0, Math.min(1, p))) / (nwin + 1)));
    } catch (err) {
      stemTrace(`win ${k + 1}/${nwin}:error`, String((err as Error)?.message ?? err)); // a CAUGHT abort (read msg) vs a silent tab-kill
      terminateWorker();
      await clearStemBlobsByPrefix(tmp);
      throw err;
    }
    const blobs: ArrayBuffer[] = [];
    for (const t of STEM_NAMES) blobs.push(raw[t][0], raw[t][1]); // [drumsL,drumsR,bassL,…] in STEM_NAMES order
    await putStemBlobs(`${tmp}${k}`, blobs);
    stemTrace(`win ${k + 1}/${nwin}:stored`); // window safely on disk; worker frees it next iteration
  }

  // ── Drop the worker to RECLAIM its ~500 MB wasm heap (wasm never shrinks) BEFORE
  // we allocate the 424 MB output below — otherwise the two collide and re-OOM. ──
  terminateWorker();
  stemTrace("windowed:assemble-alloc", `accMB=${mb(N, 4)}`); // crash here ⇒ the 424 MB output itself doesn't fit (track too long for this device)

  // ── PHASE 2: now allocate the full output (worker gone) and crossfade the windows
  // back in from disk, one at a time. Peak ≈ 424 MB + one window — the SAME footprint
  // as the DSP split, which the device already runs fine. ──
  const out: Record<string, [Float32Array, Float32Array]> = {} as never;
  for (const t of STEM_NAMES) out[t] = [new Float32Array(N), new Float32Array(N)];
  const wsum = new Float32Array(N);
  for (let k = 0; k < nwin; k++) {
    const s = k * step;
    const e = Math.min(s + WIN, N);
    const len = e - s;
    const blobs = await getStemBlobs(`${tmp}${k}`);
    await deleteStemBlobs(`${tmp}${k}`);
    if (!blobs) {
      stemTrace(`assemble ${k + 1}/${nwin}:missing`);
      continue;
    }
    const first = k === 0;
    const last = k === nwin - 1;
    for (let ti = 0; ti < STEM_NAMES.length; ti++) {
      const t = STEM_NAMES[ti];
      const wl = new Float32Array(blobs[ti * 2]);
      const wr = new Float32Array(blobs[ti * 2 + 1]);
      const o0 = out[t][0];
      const o1 = out[t][1];
      const m = Math.min(len, wl.length);
      for (let i = 0; i < m; i++) {
        const g = winGain(i, len, OV, first, last);
        o0[s + i] += wl[i] * g;
        o1[s + i] += wr[i] * g;
      }
    }
    for (let i = 0; i < len; i++) wsum[s + i] += winGain(i, len, OV, first, last);
    stemTrace(`assemble ${k + 1}/${nwin}`);
  }
  onProgress?.(nwin / (nwin + 1));

  stemTrace("windowed:normalize");
  for (const t of STEM_NAMES) {
    for (let c = 0; c < 2; c++) {
      const a = out[t][c];
      for (let i = 0; i < N; i++) a[i] /= Math.max(wsum[i], 1e-8);
    }
  }

  // Build + resample to the deck rate, freeing each stem's accumulators as we go.
  stemTrace("windowed:build", `deckSr=${mix.sampleRate}`);
  const result = {} as Stems;
  for (const t of STEM_NAMES) {
    const buf44 = makeBuffer([out[t][0], out[t][1]], SR);
    (out as Record<string, unknown>)[t] = null; // free the 44.1k accumulator
    result[t] = await resample(buf44, mix.sampleRate, mix.length);
  }
  stemTrace("windowed:done");
  return result;
}
