import type { TrackMeta } from "../library/types";

// Which radio-pool candidates get asked for analysis on a fill. Pure, so the two ways this went
// wrong are pinned by tests rather than by a comment:
//
// ★ NO SLICE ON THE D1 ASK. It used to be the first 24 un-analysed candidates, with nothing
// remembering a miss, so the same 24 were re-asked on every fill and the rest of a 60-candidate
// pool was never asked at all. The pool is ≤ POOL_MAX (60) and the endpoint takes 100 ids, so one
// request covers everyone; the pooled lookup (analysisStatus.lookupAnalysis) is what stops the
// repeats, by answering already-answered ids without a request.
//
// ★ THE ISRC ASK REMEMBERS WHAT IT TRIED. That one stays small on purpose (third-party DBs, one
// request each), and a small first-N with no memory is the same starvation in a worse place: the
// first few ISRC candidates re-asked of public infrastructure forever, the rest never.

export interface PoolEntry {
  track: TrackMeta;
}

const VIDEO_ID = /^[\w-]{11}$/;

/** Every candidate missing any of bpm/key/energy, with an id the analysis endpoint accepts. */
export function d1EnrichTargets(pool: readonly PoolEntry[]): string[] {
  return pool
    .filter((c) => (c.track.bpm == null || c.track.key == null || c.track.energy == null) && VIDEO_ID.test(c.track.videoId))
    .map((c) => c.track.videoId);
}

/** Up to `n` ISRC-carrying candidates still missing bpm or key that have not been tried yet. */
export function isrcEnrichTargets<T extends PoolEntry>(pool: readonly T[], tried: ReadonlySet<string>, n: number): T[] {
  return pool.filter((c) => (c.track.bpm == null || c.track.key == null) && !!c.track.isrc && !tried.has(c.track.videoId)).slice(0, n);
}
