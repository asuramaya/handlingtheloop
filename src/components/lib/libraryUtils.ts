import type { TrackMeta } from "@htl/library";
import { getCachedMeta } from "@htl/audio";
import { Store } from "@htl/persistence";

// Backfilled metadata for community (legacy-cached) tracks, persisted so titles
// survive reloads and we don't re-hit /api/meta on every library open.
export type CachedMeta = { title: string; artist: string; duration: number; thumbnail: string | null };
export const communityMeta = new Store<Record<string, CachedMeta>>("community-meta", {}, 1);

// Strip the "· via htl" marker htl appends to playlists it syncs out to a service,
// so the same playlist reads the same on either side and dedups by name.
export function cleanPlaylistName(title: string): string {
  return title.replace(/\s*·\s*via htl\s*$/i, "").trim();
}

// Show tempo + key for any track analyzed this session, even if it was saved
// before it was first loaded to a deck (persisted values win once they exist).
export function withCached(t: TrackMeta): TrackMeta {
  if (t.bpm != null && t.key != null) return t;
  // Read the LIGHT bpm/key cache, not getCachedTrack — the heavy decoded-buffer cache is now
  // LRU-bounded (mobile OOM fix), so its entry may have been evicted, but the scalar bpm/key
  // is kept for the whole session so the columns stay filled.
  const m = getCachedMeta(t.videoId);
  if (!m) return t;
  return {
    ...t,
    bpm: t.bpm ?? m.bpm ?? null,
    key: t.key ?? m.key ?? null,
  };
}
