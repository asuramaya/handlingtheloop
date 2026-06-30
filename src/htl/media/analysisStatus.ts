import { fetchAnalysisBatch } from "./api";

// Display-time BPM/key enrichment for list rows (Library / Search), mirroring cacheStatus.ts.
// The analysis already lives server-side in `track_analysis` (the crowdsourced metadata lane) —
// the lists just never read it, so a track the user hasn't loaded THIS session shows blank bpm/key.
// This pools the analysis for requested videoIds (batched + deduped, each id fetched once) so a row
// can show its bpm/key at a glance. NON-mutating: it never touches the synced collection — the deck
// load path still owns writing analysis back to the store for the track actually playing.

export interface RowAnalysis {
  bpm: number | null;
  key: string | null;
}

const known = new Map<string, RowAnalysis>(); // videoId → analysis (null fields = covered but unknown)
const requested = new Set<string>(); // ids already fetched or in flight — fetch each exactly once
const subscribers = new Set<() => void>();
let pending: string[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const FLUSH_MS = 120; // coalesce a burst of mounting rows into one request
const CHUNK = 100; // stay well under the /api/analysis id-list / URL length cap

/** Pooled analysis for one track, or null if not fetched yet. */
export function analysisState(videoId: string): RowAnalysis | null {
  return known.get(videoId) ?? null;
}

export function subscribeAnalysis(fn: () => void): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}

function emit() {
  subscribers.forEach((fn) => fn());
}

/** Ensure analysis is pooled for these videoIds (batched + deduped; each id fetched once). */
export function primeAnalysis(videoIds: string[]): void {
  let queued = false;
  for (const id of videoIds) {
    if (!id || requested.has(id)) continue;
    requested.add(id);
    pending.push(id);
    queued = true;
  }
  if (queued && flushTimer == null) flushTimer = setTimeout(() => void flush(), FLUSH_MS);
}

async function flush() {
  flushTimer = null;
  const batch = pending;
  pending = [];
  if (!batch.length) return;
  let changed = false;
  for (let i = 0; i < batch.length; i += CHUNK) {
    const slice = batch.slice(i, i + CHUNK);
    const ana = await fetchAnalysisBatch(slice);
    for (const id of slice) {
      known.set(id, ana[id] ?? { bpm: null, key: null }); // record misses too → never re-fetch
      changed = true;
    }
  }
  if (changed) emit();
}
