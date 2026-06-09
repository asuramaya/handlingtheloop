// Stem separation, mobile-first. The model is NEVER bundled and NEVER runs on a
// weak device: the flow is cache-first.
//
//   1. ask the Worker which stems are already in R2 (separated by someone before)
//   2. if all four are there -> just DOWNLOAD + decode them (this is the phone path)
//   3. otherwise, only on a capable device, run the model in-browser (onnxruntime
//      loaded from a CDN on demand), then UPLOAD the stems to R2 so the next
//      person — including phones — gets the cheap download path.
//
// So the heavy compute happens once, on whoever can do it, and is shared via R2.
import { decodeAudio } from "../audio/decode";

export const STEM_NAMES = ["vocals", "drums", "bass", "other"] as const;
export type StemName = (typeof STEM_NAMES)[number];
export type Stems = Record<StemName, AudioBuffer>;

export interface StemManifest {
  stems: StemName[];
  complete: boolean;
}

export async function fetchStemManifest(videoId: string): Promise<StemManifest> {
  try {
    const res = await fetch(`/api/stems?v=${encodeURIComponent(videoId)}`);
    if (!res.ok) return { stems: [], complete: false };
    return (await res.json()) as StemManifest;
  } catch {
    return { stems: [], complete: false };
  }
}

async function downloadStem(ctx: BaseAudioContext, videoId: string, name: StemName): Promise<AudioBuffer> {
  const res = await fetch(`/api/stems?v=${encodeURIComponent(videoId)}&s=${name}`);
  if (!res.ok) throw new Error(`stem ${name} ${res.status}`);
  return decodeAudio(ctx, await res.arrayBuffer());
}

async function uploadStem(videoId: string, name: StemName, bytes: ArrayBuffer, contentType: string): Promise<void> {
  try {
    await fetch(`/api/stems?v=${encodeURIComponent(videoId)}&s=${name}`, {
      method: "PUT",
      headers: { "content-type": contentType },
      body: bytes,
    });
  } catch {
    /* best-effort cache write */
  }
}

// Whether THIS device should attempt on-device separation. Phones and low-power
// machines skip it and rely on the shared cache. WebGPU is the fast path.
export function canSeparate(): boolean {
  if (typeof navigator === "undefined") return false;
  const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  const hasGpu = "gpu" in navigator;
  const cores = navigator.hardwareConcurrency ?? 2;
  const mem = (navigator as unknown as { deviceMemory?: number }).deviceMemory ?? 4;
  if (hasGpu) return true; // WebGPU is fast enough even on better phones
  return !mobile && cores >= 4 && mem >= 4;
}

export type StemProgress = (stage: "download" | "separate", pct: number) => void;

/**
 * Get the four stems for a track, preferring the shared R2 cache. Returns null if
 * stems aren't cached and this device can't (or shouldn't) separate them.
 */
export async function getStems(
  ctx: BaseAudioContext,
  videoId: string,
  fullMix: AudioBuffer,
  onProgress?: StemProgress,
): Promise<Stems | null> {
  const manifest = await fetchStemManifest(videoId);

  // Fast path (and the only path on phones): download what's cached.
  if (manifest.complete) {
    const out = {} as Stems;
    for (let i = 0; i < STEM_NAMES.length; i++) {
      const name = STEM_NAMES[i];
      out[name] = await downloadStem(ctx, videoId, name);
      onProgress?.("download", ((i + 1) / STEM_NAMES.length) * 100);
    }
    return out;
  }

  if (!canSeparate()) return null;

  // Heavy path: separate locally, then share to R2 for everyone else.
  const stems = await separateOnDevice(fullMix, (pct) => onProgress?.("separate", pct));
  if (!stems) return null;
  void encodeAndUpload(videoId, stems);
  return stems;
}

// --- on-device separation (capable devices only) ----------------------------
// onnxruntime-web + the Demucs ONNX model are pulled from a CDN at call time, so
// nothing here is in the app bundle and none of it ever loads on a phone.
const ORT_CDN = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/ort.webgpu.min.mjs";
// A 4-stem HT-Demucs export (set to your hosted/HF model). Left configurable
// because the exact tensor I/O is model-specific and needs device testing.
const MODEL_URL = "/models/htdemucs.onnx";

let ortPromise: Promise<unknown> | null = null;
function loadOrt(): Promise<unknown> {
  if (!ortPromise) ortPromise = import(/* @vite-ignore */ ORT_CDN);
  return ortPromise;
}

/**
 * Run the separation model over the decoded mix. Implemented as a chunked
 * overlap-add pass so it streams within memory limits. The model load + exact
 * input/output tensor handling is the one piece that must be verified on a real
 * device against the chosen ONNX export — it throws until that's wired.
 */
export async function separateOnDevice(_mix: AudioBuffer, _onProgress?: (pct: number) => void): Promise<Stems | null> {
  await loadOrt();
  // INTEGRATION POINT: create an InferenceSession from MODEL_URL (webgpu →
  // wasm fallback), then for each ~7.8s chunk feed [1,2,N] samples, read the
  // [1,4,2,N] output, and overlap-add into four output buffers. Needs the model.
  throw new Error(`stem model not wired yet (load ${MODEL_URL})`);
}

// Encode each stem to compact Opus (via MediaRecorder, no deps) and upload.
async function encodeAndUpload(videoId: string, stems: Stems): Promise<void> {
  for (const name of STEM_NAMES) {
    try {
      const bytes = await encodeOpus(stems[name]);
      await uploadStem(videoId, name, bytes, "audio/webm");
    } catch {
      /* skip this stem's cache write */
    }
  }
}

// Render an AudioBuffer to a webm/opus blob using the browser's own encoder.
async function encodeOpus(buffer: AudioBuffer): Promise<ArrayBuffer> {
  const ctx = new AudioContext();
  const dest = ctx.createMediaStreamDestination();
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(dest);
  const rec = new MediaRecorder(dest.stream, { mimeType: "audio/webm;codecs=opus" });
  const chunks: BlobPart[] = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const done = new Promise<ArrayBuffer>((resolve) => {
    rec.onstop = async () => {
      await ctx.close();
      resolve(await new Blob(chunks).arrayBuffer());
    };
  });
  rec.start();
  src.start();
  src.onended = () => rec.stop();
  return done;
}
