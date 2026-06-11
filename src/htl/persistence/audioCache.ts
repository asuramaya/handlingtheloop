// Durable audio-bytes cache in IndexedDB, keyed by videoId. Lets a refreshed
// deck re-hydrate instantly (and offline) instead of re-hitting the resolver.
// Stores the raw encoded bytes (audio/mp4 etc.), not the decoded PCM — far
// smaller, and decode is cheap browser-side. All ops fail soft (resolve to
// null / no-op) so the app works even where IndexedDB is unavailable.

const DB_NAME = "htl";
const STORE = "audio";
const STEM_STORE = "stems"; // separated stems (WAV bytes) keyed by `${videoId}:${modelId}`
const DB_VERSION = 2;

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") return resolve(null);
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
        if (!db.objectStoreNames.contains(STEM_STORE)) db.createObjectStore(STEM_STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

interface AudioRecord {
  bytes: ArrayBuffer;
  contentType: string;
  savedAt: number;
}

export async function getAudio(videoId: string): Promise<{ bytes: ArrayBuffer; contentType: string } | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(videoId);
      req.onsuccess = () => {
        const rec = req.result as AudioRecord | undefined;
        resolve(rec ? { bytes: rec.bytes, contentType: rec.contentType } : null);
      };
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function putAudio(videoId: string, bytes: ArrayBuffer, contentType = "audio/mp4"): Promise<void> {
  const db = await openDb();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, "readwrite");
      const rec: AudioRecord = { bytes, contentType, savedAt: Date.now() };
      tx.objectStore(STORE).put(rec, videoId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

export async function hasAudio(videoId: string): Promise<boolean> {
  return (await getAudio(videoId)) != null;
}

// --- separated-stem cache (so a refresh re-applies stems instantly instead of
// re-downloading from R2 or re-separating). Stores the four WAV byte buffers. ---
interface StemRecord {
  blobs: ArrayBuffer[];
  savedAt: number;
}

export async function getStemBlobs(key: string): Promise<ArrayBuffer[] | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STEM_STORE, "readonly");
      const req = tx.objectStore(STEM_STORE).get(key);
      req.onsuccess = () => {
        const rec = req.result as StemRecord | undefined;
        resolve(rec?.blobs && rec.blobs.length ? rec.blobs : null);
      };
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function putStemBlobs(key: string, blobs: ArrayBuffer[]): Promise<void> {
  const db = await openDb();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STEM_STORE, "readwrite");
      tx.objectStore(STEM_STORE).put({ blobs, savedAt: Date.now() } as StemRecord, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve(); // fail soft (quota, etc.) — R2 remains the fallback
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

// Cheap existence check — does NOT load the (possibly 100s-of-MB) blobs into RAM.
export async function hasStemBlobs(key: string): Promise<boolean> {
  const db = await openDb();
  if (!db) return false;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STEM_STORE, "readonly");
      const req = tx.objectStore(STEM_STORE).getKey(key);
      req.onsuccess = () => resolve(req.result != null);
      req.onerror = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

export async function deleteStemBlobs(key: string): Promise<void> {
  const db = await openDb();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STEM_STORE, "readwrite");
      tx.objectStore(STEM_STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

// Delete every stem key beginning with `prefix` (used to GC leftover windowed-
// separation temp blobs from a crashed/aborted run).
export async function clearStemBlobsByPrefix(prefix: string): Promise<void> {
  const db = await openDb();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STEM_STORE, "readwrite");
      const store = tx.objectStore(STEM_STORE);
      const range = IDBKeyRange.bound(prefix, prefix + "￿");
      const req = store.openKeyCursor(range);
      req.onsuccess = () => {
        const cur = req.result;
        if (cur) {
          store.delete(cur.key);
          cur.continue();
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}
