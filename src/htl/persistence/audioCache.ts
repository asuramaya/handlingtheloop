// Durable audio-bytes cache in IndexedDB, keyed by videoId. Lets a refreshed
// deck re-hydrate instantly (and offline) instead of re-hitting the resolver.
// Stores the raw encoded bytes (audio/mp4 etc.), not the decoded PCM — far
// smaller, and decode is cheap browser-side. All ops fail soft (resolve to
// null / no-op) so the app works even where IndexedDB is unavailable.

const DB_NAME = "htl";
const STORE = "audio";
const DB_VERSION = 1;

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
