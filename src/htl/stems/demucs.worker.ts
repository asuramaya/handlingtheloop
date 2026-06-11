/// <reference lib="webworker" />
// HT-Demucs separation worker — runs the demucs-rs (Rust + Burn + wgpu/WebGPU)
// engine off the main thread so playback/UI never hang. Weights (safetensors)
// are fetched once and cached; the GPU does the inference.
import init, { separate, warmup_model, import_autotune, export_autotune } from "./wasm/demucs_wasm.js";
import { loadAutotune, saveAutotune, autotuneKey } from "./autotuneCache";

let ready: Promise<unknown> | null = null;
const weightsCache = new Map<string, Uint8Array>();
const warmed = new Set<string>();
// Restore CubeCL autotune winners from IndexedDB ONCE, before the first GPU op, so
// the kernel-benchmark storm ("stuck at 0%") is skipped after the first-ever run.
let autotuneImported = false;
const AUTOTUNE_KEY = autotuneKey("demucs", "default");
async function restoreAutotune(): Promise<void> {
  if (autotuneImported) return;
  autotuneImported = true;
  const blob = await loadAutotune(AUTOTUNE_KEY);
  console.log(`[htl-autotune] restoreAutotune: ${blob ? blob.length + " bytes from IDB → import" : "no cached blob"}`);
  if (blob) import_autotune(blob);
}
async function persistAutotune(): Promise<void> {
  try {
    const json = export_autotune();
    console.log(`[htl-autotune] persistAutotune: export ${json.length} bytes → IDB key ${AUTOTUNE_KEY}`);
    await saveAutotune(AUTOTUNE_KEY, json);
    console.log(`[htl-autotune] persistAutotune: saved`);
  } catch (e) {
    console.log(`[htl-autotune] persistAutotune FAILED: ${String((e as Error)?.message ?? e)}`);
  }
}

async function getWeights(url: string): Promise<Uint8Array> {
  let w = weightsCache.get(url);
  if (!w) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`weights ${res.status}`);
    w = new Uint8Array(await res.arrayBuffer());
    weightsCache.set(url, w);
  }
  return w;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
self.onmessage = async (e: MessageEvent) => {
  const { type, id } = e.data;
  if (type !== "separate") return;
  try {
    if (!ready) ready = init();
    await ready;
    await restoreAutotune(); // import saved kernel winners before any GPU work
    const { weightsUrl, wasmModel, left, right, sampleRate } = e.data;
    const bytes = await getWeights(weightsUrl);
    if (!warmed.has(wasmModel)) {
      await warmup_model(bytes, wasmModel); // pre-compile GPU shaders once per model
      warmed.add(wasmModel);
      // warmup's dummy forward pass autotunes ~every kernel shape, so the cache is
      // already (mostly) populated here — persist it now so the expensive winners
      // survive even if the full separation is interrupted (incremental cache build).
      void persistAutotune();
    }
    const onProgress = (ev: any) => self.postMessage({ type: "progress", id, event: ev });
    const res = await separate(
      bytes,
      wasmModel,
      ["drums", "bass", "other", "vocals"],
      new Float32Array(left),
      new Float32Array(right),
      sampleRate,
      onProgress,
    );
    // read getters BEFORE take_audio() (it consumes the result)
    const nSamples: number = res.n_samples;
    const numStems: number = res.num_stems;
    const names: string[] = res.stem_names();
    const audio: Float32Array = res.take_audio(); // per-stem [ L(n) , R(n) ] blocks
    self.postMessage({ type: "done", id, audio, nSamples, numStems, names }, { transfer: [audio.buffer] });
    void persistAutotune(); // save any newly-tuned kernel winners for next time
  } catch (err) {
    self.postMessage({ type: "error", id, message: String((err as Error)?.message ?? err) });
  }
};
