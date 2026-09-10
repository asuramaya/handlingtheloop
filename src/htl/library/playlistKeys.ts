// Playlist membership migration: videoIds -> trackKeys.
//
// The collection dedupes on `trackKey` (identity.ts) but playlist membership was stored
// as raw `videoId` strings, so the two layers disagreed about what "the same track" means.
// This carries legacy membership across.
//
// SHAPE-DETECTED, NOT VERSION-GATED, and deliberately so. A version bump only guards the
// LOCAL key, and the multi-device case is the one that matters here: a device still on the
// old build keeps pushing legacy-shaped playlists into the cross-device sync blob forever,
// so a migration wired only at load() would look perfectly correct on the machine that
// wrote it and quietly do nothing for everyone else. Detecting the shape instead means the
// same function runs at EVERY ingest boundary — local load and remote adopt — and is
// idempotent, so running it twice is free.
import { trackKey } from "./identity";
import type { Playlist, TrackMeta } from "./types";

/** A playlist as it may arrive from storage or a peer device: either shape, or mid-flight
 *  both (a legacy field left beside a migrated one). */
export type StoredPlaylist = Omit<Playlist, "trackKeys"> & {
  trackKeys?: string[];
  /** Legacy: raw videoIds, in order. Written by builds before this migration. */
  trackIds?: string[];
};

/** videoId -> trackKey for everything the collection can identify. Built once per migration
 *  rather than per member, so a 2000-track collection crossed with a 500-track playlist is
 *  one pass each and not half a million comparisons. */
function keyIndex(collection: TrackMeta[]): Map<string, string> {
  const ix = new Map<string, string>();
  for (const t of collection) {
    const vid = (t.videoId ?? "").trim();
    if (!vid) continue; // unresolved catalog rows share the empty id — indexing them would collide
    const key = trackKey(t);
    if (!ix.has(vid)) ix.set(vid, key); // first wins: a stable answer beats a last-write-wins race
  }
  return ix;
}

/** Legacy membership -> trackKeys, resolved through the collection.
 *
 *  A member the collection cannot identify is PRESERVED VERBATIM, never dropped. A migration
 *  that silently shortens someone's playlist is a far worse outcome than one that leaves an
 *  id it could not translate: the unresolvable member is almost always a track the user
 *  removed from the collection but deliberately kept in a list, and `yt:<id>` is what
 *  trackKey would have produced for it anyway once it returns. */
export function migrateMembership(trackIds: string[], collection: TrackMeta[]): string[] {
  const ix = keyIndex(collection);
  return trackIds.map((id) => translate(id, ix));
}

/** One id, through the index. The fallback mirrors trackKey's own YouTube branch so an
 *  untranslatable bare id lands in the SAME namespace the collection would give it, rather
 *  than in a private third form no later lookup would ever match. An id that already looks
 *  like a key (it carries a `ns:` prefix) is passed through — that is a re-run, not a miss. */
function translate(id: string, ix: Map<string, string>): string {
  return ix.get(id) ?? (id.includes(":") ? id : `yt:${id}`);
}

/** sourceMatch VALUES are matched videoIds; its KEYS are already source-side identities and
 *  must not be touched. Left in the same id space as membership, re-sync dedup would compare
 *  a trackKey against a videoId, never match, and re-accrete exactly the duplicates this
 *  field exists to prevent. */
function migrateSourceMatch(
  sourceMatch: Record<string, string> | undefined,
  ix: Map<string, string>,
): Record<string, string> | undefined {
  if (!sourceMatch) return sourceMatch;
  const out: Record<string, string> = {};
  for (const [src, vid] of Object.entries(sourceMatch)) {
    out[src] = translate(vid, ix);
  }
  return out;
}

/** True when this playlist still carries legacy membership needing translation. */
export function needsMigration(p: StoredPlaylist): boolean {
  return !p.trackKeys && Array.isArray(p.trackIds);
}

/** Idempotent. Playlists already carrying `trackKeys` pass through untouched — including
 *  their sourceMatch, which migrated in the same act the first time. */
export function migratePlaylists(playlists: StoredPlaylist[], collection: TrackMeta[]): Playlist[] {
  if (!playlists.some(needsMigration)) {
    return playlists.map(({ trackIds: _legacy, ...p }) => ({ ...p, trackKeys: p.trackKeys ?? [] }));
  }
  const ix = keyIndex(collection);
  return playlists.map((p) => {
    const { trackIds: legacy, ...rest } = p;
    if (p.trackKeys) return { ...rest, trackKeys: p.trackKeys };
    return {
      ...rest,
      trackKeys: (legacy ?? []).map((id) => translate(id, ix)),
      sourceMatch: migrateSourceMatch(p.sourceMatch, ix),
    };
  });
}
