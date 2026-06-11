// Local persistence for CubeCL autotune results (the demucs WebGPU kernel-selection
// cache). CubeCL re-benchmarks every kernel shape on each page load — minutes of
// "stuck at 0%". The wasm exposes the winners as a JSON blob; we round-trip it
// through IndexedDB so the cold-start is paid ONCE per device, not per load.
//
// This is step 1 of the crowd-sourced design: prove local persistence skips the
// storm. Step 2 swaps/augments the store for a worker-served shared pool keyed by
// GPU fingerprint + CubeCL version, so the first run on a known GPU is instant too.
//
// Keyed by (model + a coarse device tag): the winning kernel is GPU-specific, so a
// cache from one machine isn't valid on another — but a mismatch only costs speed
// (every candidate is correct), and we re-tune + overwrite if it's wrong.

const DB_NAME = "htl-autotune";
const DB_VERSION = 1;
const STORE = "cache";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// A coarse per-device key. WebGPU blanks adapter identity, so we lean on the wasm
// build version + a caller-supplied tag (later: GPU fingerprint). Same machine →
// same key → cache hit; different GPU → miss → re-tune (safe).
export function autotuneKey(modelId: string, deviceTag = "default"): string {
  return `${modelId}:${deviceTag}`;
}

export async function loadAutotune(key: string): Promise<string | null> {
  try {
    const db = await open();
    return await new Promise<string | null>((resolve) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => resolve(typeof req.result === "string" ? req.result : null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null; // IDB unavailable (private mode) — just re-tune
  }
}

export async function saveAutotune(key: string, json: string): Promise<void> {
  if (!json || json === "{}") return; // nothing tuned
  try {
    const db = await open();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(json, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    /* fail-soft: cache is an optimization, never required */
  }
}
