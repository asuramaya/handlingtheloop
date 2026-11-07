// The chromaprint, OFF the main thread. A 2-minute fingerprint is ~0.25–0.5 s of solid work (the
// int16 downmix + the wasm), measured as single long tasks in a real AUTO session — a frozen
// screen and a stalled jog whenever the queue prefetch identified a track. Here it costs nothing
// the user can feel. See index.ts for the caller and the in-thread fallback.
import init, { fingerprint } from "./wasm/htl_fingerprint.js";
import wasmUrl from "./wasm/htl_fingerprint_bg.wasm?url";
import { downmixInt16 } from "./downmix";

let ready: Promise<unknown> | null = null;

self.onmessage = async (e: MessageEvent<{ id: number; ch0: Float32Array; ch1: Float32Array | null; sr: number }>) => {
  const { id, ch0, ch1, sr } = e.data;
  try {
    await (ready ??= init({ module_or_path: wasmUrl }));
    const fp = fingerprint(downmixInt16(ch0, ch1, ch0.length), sr, 1) ?? null;
    (self as unknown as Worker).postMessage({ id, fp });
  } catch {
    (self as unknown as Worker).postMessage({ id, fp: null });
  }
};
