// Pure logic for re-syncing a fuzzy-matched (Spotify/TIDAL) playlist. Kept out of the async import
// hook so the identity/dedup decisions are testable in isolation (the hook just does the network +
// applies the result). The whole point: follow each song by its SOURCE identity, not by whichever
// YouTube video it happened to match to — a re-match drifts to a different video across runs, and
// keying on that video was what accreted duplicates forever.

import { trackKey } from "./identity";

// Structural shape of a provider source track (a subset of @htl/account's SourceTrack) — declared
// here so the library layer doesn't import the account layer just for a type.
export interface SourceLike {
  title: string;
  artist: string;
  isrc: string | null;
  spotifyId: string | null;
  videoId: string | null;
}

/** Stable identity for a SOURCE (pre-match) track, via the SAME global engine the collection uses
 *  (`trackKey`): a real videoId if it already has one, else ISRC → provider:id (Spotify) → a
 *  normalized artist|title. One identity function across the whole library, not a per-surface
 *  reimplementation. */
export function sourceTrackKey(t: SourceLike): string {
  return trackKey({
    videoId: t.videoId ?? "",
    isrc: t.isrc,
    provider: t.spotifyId ? "spotify" : undefined,
    providerId: t.spotifyId ?? undefined,
    title: t.title,
    artist: t.artist,
  });
}

/** The source tracks that still need a (re)match: those with no still-present video carried in the
 *  current source map. A carried song is left exactly as it is — no re-match, no drift, no churn. */
export function resyncNeedsMatch<T>(
  sources: T[],
  keyOf: (t: T) => string,
  oldMap: Record<string, string>,
  currentIds: Set<string>,
): T[] {
  return sources.filter((s) => {
    const prev = oldMap[keyOf(s)];
    return !(prev && currentIds.has(prev));
  });
}

export interface ResyncReconcile {
  newMap: Record<string, string>; // rebuilt source-key → videoId map to store on the playlist
  addIds: string[]; // matched videoIds not already in the playlist → add these
  removeIds: string[]; // source-managed videoIds to prune (always empty on a truncated read)
}

/** Reconcile a matched-playlist re-sync — PURE, so it can be exhaustively tested.
 *
 *  Inputs: the previous source→video map, the playlist's current videoIds, the source keys READ this
 *  run (a possibly-truncated subset of the real playlist), the matches produced for the un-carried
 *  keys (key → videoId), and whether the read was truncated.
 *
 *  Guarantees:
 *   - a song CARRIED from last time keeps its exact video (no drift, no duplicate);
 *   - a NEW/re-matched song is added once (deduped against what's already there);
 *   - a song is PRUNED only when its key is gone from a COMPLETE read — never a manual add (a video
 *     never in the map), never a this-run match miss (its key stays carried or simply isn't pruned);
 *   - a TRUNCATED read prunes NOTHING and preserves the keys it didn't see (the tail survives). */
export function reconcileResync(opts: {
  oldMap: Record<string, string>;
  currentIds: Set<string>;
  sourceKeys: string[];
  matched: Record<string, string>;
  truncated: boolean;
}): ResyncReconcile {
  const { oldMap, currentIds, sourceKeys, matched, truncated } = opts;
  const carry: Record<string, string> = {};
  for (const key of sourceKeys) {
    const prev = oldMap[key];
    if (prev && currentIds.has(prev)) carry[key] = prev; // still have this song's video — keep it as-is
  }
  const newMap = { ...carry, ...matched };
  const addIds = Object.values(matched).filter((vid) => !currentIds.has(vid));
  if (truncated) {
    // Incomplete read → never prune, and keep the keys we didn't see this run so the tail survives.
    return { newMap: { ...oldMap, ...newMap }, addIds, removeIds: [] };
  }
  const removeIds: string[] = [];
  for (const [key, vid] of Object.entries(oldMap)) {
    if (!currentIds.has(vid)) continue; // already not in the playlist — nothing to prune
    const now = newMap[key];
    if (now === undefined) removeIds.push(vid); // the song is gone from the source → prune it
    else if (now !== vid) removeIds.push(vid); // the song re-matched to a DIFFERENT video → drop the stale one,
    // else: unchanged — leave it exactly as it is.
  }
  return { newMap, addIds, removeIds };
}
