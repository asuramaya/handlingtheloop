// Community index — the browsable catalog of cached tracks. Decouples the community
// list from an R2 bucket scan: an indexed, ordered query instead of O(objects) per
// request.
import { type D1Database, now } from "./core";

export interface CommunityTrack {
  videoId: string;
  title: string;
  artist: string;
  duration: number;
  thumbnail: string | null;
}

interface CommunityRow {
  video_id: string;
  title: string;
  artist: string | null;
  duration: number;
  thumbnail: string | null;
}

/** Insert/refresh a track in the community index. Empty fields never clobber known ones. */
export async function upsertCommunityTrack(
  db: D1Database,
  t: { videoId: string; title?: string; artist?: string | null; duration?: number; thumbnail?: string | null },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO community_tracks (video_id, title, artist, duration, thumbnail, cached_at, updated_at)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(video_id) DO UPDATE SET
         title     = CASE WHEN excluded.title <> '' THEN excluded.title ELSE community_tracks.title END,
         artist    = COALESCE(NULLIF(excluded.artist, ''), community_tracks.artist),
         duration  = CASE WHEN excluded.duration > 0 THEN excluded.duration ELSE community_tracks.duration END,
         thumbnail = COALESCE(excluded.thumbnail, community_tracks.thumbnail),
         updated_at = excluded.updated_at`,
    )
    .bind(t.videoId, t.title ?? "", t.artist ?? null, t.duration ?? 0, t.thumbnail ?? null, now(), now())
    .run();
}

/** Newest-first page of the community catalog. */
export async function listCommunityTracks(db: D1Database, limit: number): Promise<CommunityTrack[]> {
  const r = await db
    .prepare("SELECT video_id, title, artist, duration, thumbnail FROM community_tracks ORDER BY cached_at DESC LIMIT ?")
    .bind(Math.max(1, Math.min(limit, 5000)))
    .all<CommunityRow>();
  return (r.results ?? []).map((x) => ({
    videoId: x.video_id,
    title: x.title,
    artist: x.artist ?? "",
    duration: x.duration,
    thumbnail: x.thumbnail,
  }));
}

/** Remove a track from the catalog (takedown). Bytes stay in R2 until separately purged. */
export async function deleteCommunityTrack(db: D1Database, videoId: string): Promise<void> {
  await db.prepare("DELETE FROM community_tracks WHERE video_id = ?").bind(videoId).run();
}

/** Total tracks in the community catalog. */
export async function countCommunityTracks(db: D1Database): Promise<number> {
  const r = await db.prepare("SELECT COUNT(*) AS n FROM community_tracks").first<{ n: number }>();
  return r?.n ?? 0;
}
