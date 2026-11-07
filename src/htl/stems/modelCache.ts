// Persistent cache for model weights (the ~170 MB demucs core), keyed by the STABLE model URL.
//
// ★ WHY THIS EXISTS: "it keeps downloading the model instead of caching it". The browser HTTP
// cache can never hit for our weights. huggingface.co/…/resolve/main/<file> answers with a 302
// marked `cache-control: no-store`, pointing at a SIGNED CDN URL whose Expires/Signature query
// changes on every request (measured 2026-11-04: two HEADs seconds apart got Expires=…159 and
// Expires=…166). The 200 behind it is cacheable, but under a key nobody will ever ask for again —
// so every worker spawn (and separate.ts terminates the worker after every windowed job to reclaim
// its wasm heap) re-pulled all 170 MB. The Cache API lets us choose the key ourselves: the
// unsigned resolve URL, which only changes when we change models.ts.
//
// Bump the cache NAME if a model is ever re-exported under the SAME URL — the key can't see it.
export const MODEL_CACHE = "htl-models-v1";

// A minimal slice of CacheStorage, so the logic is testable without a browser.
export interface ModelCacheStorage {
  open(name: string): Promise<{
    match(key: string): Promise<Response | undefined>;
    put(key: string, res: Response): Promise<void>;
  }>;
}

function defaultStorage(): ModelCacheStorage | null {
  // Cache API is secure-context only (https / localhost) — on plain-http LAN it's absent.
  return typeof caches !== "undefined" ? (caches as unknown as ModelCacheStorage) : null;
}

/**
 * Return the bytes for `url` from the persistent cache, else `download()` them and store them.
 * A null download (an expected 404, e.g. the speculative .onnx.data sidecar probe) is NOT cached.
 * Every cache failure (quota, private mode, an evicted/corrupt entry) degrades to the network —
 * caching is an optimisation and must never fail a load that would otherwise work.
 */
export async function cachedModelBytes(
  url: string,
  download: () => Promise<ArrayBuffer | null>,
  storage: ModelCacheStorage | null = defaultStorage(),
): Promise<ArrayBuffer | null> {
  let cache: Awaited<ReturnType<ModelCacheStorage["open"]>> | null = null;
  try {
    cache = storage ? await storage.open(MODEL_CACHE) : null;
    const hit = await cache?.match(url);
    if (hit) {
      const buf = await hit.arrayBuffer();
      if (buf.byteLength > 0) return buf;
    }
  } catch {
    /* unreadable cache → fall through to the network */
  }
  const bytes = await download();
  if (bytes && cache) {
    try {
      // Stored only after the download fully assembled (fetchResumable checks received >= total),
      // so a truncated transfer can't poison the cache. A Response copies a BufferSource body (it
      // does not detach it), so the caller keeps its buffer — no extra slice() needed.
      await cache.put(url, new Response(bytes, { headers: { "content-type": "application/octet-stream" } }));
    } catch {
      /* quota exceeded etc. — the session still has the bytes */
    }
  }
  return bytes;
}
