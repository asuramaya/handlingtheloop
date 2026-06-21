import { getCachedTrack } from "../audio/trackCache";

// Persistent cache status for tracks, shared by the Library + Search lists so a row
// can show at a glance whether a song loads instantly (its audio is already pooled in
// R2) and whether its separated stems are cached too. The pool manifest is fetched
// once, lazily, on first use; list components subscribe and re-render when it lands.

const pooledSongs = new Set<string>(); // videoIds whose audio is cached in the shared pool
const pooledStems = new Set<string>(); // videoIds whose stems are cached server-side
const subscribers = new Set<() => void>();
let primed = false;

export interface CacheState {
  song: boolean; // audio cached (community pool) or decoded this session → instant load
  stems: boolean; // separated stems cached server-side
}

/** Cache state for one track. `getCachedTrack` covers anything decoded this session. */
export function cacheState(videoId: string): CacheState {
  return {
    song: pooledSongs.has(videoId) || !!getCachedTrack(videoId),
    stems: pooledStems.has(videoId),
  };
}

export function subscribeCacheStatus(fn: () => void): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}

function emit() {
  subscribers.forEach((fn) => fn());
}

/** Fetch the cached-pool manifest once (audio + a per-track stems flag). The `stems=1`
 *  hint asks the worker to annotate which pooled tracks also have cached stems. Safe to
 *  call from every list mount — it only does work the first time. */
export function primeCachePool(): void {
  if (primed) return;
  primed = true;
  fetch("/api/community?limit=5000&stems=1")
    .then((r) => (r.ok ? r.json() : { tracks: [] }))
    .then((d: { tracks?: { videoId?: string; stems?: boolean }[] }) => {
      let changed = false;
      for (const t of d.tracks ?? []) {
        if (!t.videoId) continue;
        pooledSongs.add(t.videoId);
        if (t.stems) pooledStems.add(t.videoId);
        changed = true;
      }
      if (changed) emit();
    })
    .catch(() => {
      /* offline / not configured — badges simply stay hidden */
    });
}
