import init, { fingerprint } from "./wasm/htl_fingerprint.js";
import wasmUrl from "./wasm/htl_fingerprint_bg.wasm?url";
import { downmixInt16 } from "./downmix";

// Chromaprint (AcoustID-compatible) fingerprint of a decoded AudioBuffer, via the
// pure-Rust rusty-chromaprint compiled to wasm. Used by the background precompute to
// identify a track's canonical recording (→ ISRC) instead of guessing from its title.
//
// ★ IN A WORKER (2026-11-04). It ran here, on the main thread, as one 250–500 ms block — the
// largest long task in a profiled AUTO session, landing whenever the queue prefetch identified a
// track. The worker gets copies of the two channels (the AudioBuffer is still needed here) and does
// the downmix and the wasm. The in-thread path stays as the fallback where workers do not exist.

let ready: Promise<void> | null = null;
function ensure(): Promise<void> {
  return (ready ??= init({ module_or_path: wasmUrl }).then(() => undefined));
}

// AcoustID matches on ~the first two minutes; no need to fingerprint a whole track.
const FP_SECONDS = 120;

let worker: Worker | null = null;
let workerBroken = false;
let seq = 0;
const pending = new Map<number, (fp: string | null) => void>();

function getWorker(): Worker | null {
  if (workerBroken || typeof Worker === "undefined") return null;
  if (!worker) {
    try {
      worker = new Worker(new URL("./fingerprint.worker.ts", import.meta.url), { type: "module" });
      worker.onmessage = (e: MessageEvent<{ id: number; fp: string | null }>) => {
        pending.get(e.data.id)?.(e.data.fp);
        pending.delete(e.data.id);
      };
      worker.onerror = () => {
        // A worker that cannot start (CSP, an old browser) fails every job; answer them and fall
        // back to the in-thread path from now on rather than hang the prefetch.
        workerBroken = true;
        for (const r of pending.values()) r(null);
        pending.clear();
        worker = null;
      };
    } catch {
      workerBroken = true;
      return null;
    }
  }
  return worker;
}

/** AcoustID-format fingerprint (base64) of a buffer, or null on failure/too-short. */
export async function fingerprintBuffer(buffer: AudioBuffer): Promise<string | null> {
  try {
    const sr = buffer.sampleRate;
    const frames = Math.min(buffer.length, Math.floor(sr * FP_SECONDS));
    if (frames < sr * 10) return null; // <10s — not worth identifying
    const w = getWorker();
    if (w) {
      const ch0 = buffer.getChannelData(0).slice(0, frames);
      const ch1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1).slice(0, frames) : null;
      const id = ++seq;
      return await new Promise<string | null>((resolve) => {
        pending.set(id, resolve);
        w.postMessage({ id, ch0, ch1, sr }, ch1 ? [ch0.buffer, ch1.buffer] : [ch0.buffer]);
      });
    }
    await ensure();
    const ch0 = buffer.getChannelData(0);
    const ch1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : null;
    return fingerprint(downmixInt16(ch0, ch1, frames), sr, 1) ?? null;
  } catch {
    return null;
  }
}
