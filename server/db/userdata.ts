// Per-user synced data: the UI settings blob + play stats ("top songs").
import { type D1Database, now } from "./core";

/** The signed-in user's synced UI settings blob (JSON string), or null if never saved. */
export async function getUserSettings(
  db: D1Database,
  userId: string,
): Promise<{ data: string; updated_at: number } | null> {
  return db
    .prepare("SELECT data, updated_at FROM user_settings WHERE user_id = ?")
    .bind(userId)
    .first<{ data: string; updated_at: number }>();
}

/** Upsert the user's settings blob (last-write-wins by the client-supplied timestamp). */
export async function putUserSettings(db: D1Database, userId: string, data: string, updatedAt: number): Promise<void> {
  // Conditional upsert: only write when the incoming value is BOTH newer (last-write-wins) AND
  // actually different. A stale or identical PUT (a cross-device adopt re-pushing the same blob)
  // no-ops at the DB — 0 rows written, no separate read needed.
  await db
    .prepare(
      `INSERT INTO user_settings (user_id, data, updated_at) VALUES (?,?,?)
       ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
         WHERE excluded.updated_at > user_settings.updated_at AND excluded.data <> user_settings.data`,
    )
    .bind(userId, data, updatedAt)
    .run();
}

// --- Per-user play stats (the profile's "top songs") ---------------------------
// An aggregate, not a log: one row per (user, track) with a running count, so "top N"
// is an indexed query and the table can't grow without bound. See migration 0008 — also
// ensured here so it works before the migration is applied to an existing DB.
let ensuredPlays = false;
async function ensureUserPlays(db: D1Database): Promise<void> {
  if (ensuredPlays) return;
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS user_track_stats (
         user_id TEXT NOT NULL, video_id TEXT NOT NULL,
         title TEXT, artist TEXT, thumbnail TEXT,
         plays INTEGER NOT NULL DEFAULT 0, last_played_at INTEGER NOT NULL,
         PRIMARY KEY (user_id, video_id))`,
    )
    .run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_user_track_plays ON user_track_stats(user_id, plays DESC)").run();
  ensuredPlays = true;
}

export interface TopTrack {
  videoId: string;
  title: string;
  artist: string;
  thumbnail: string | null;
  plays: number;
}

/** Record one play of a track by a user (increments the running count, refreshes meta). */
export async function logUserPlay(
  db: D1Database,
  userId: string,
  t: { videoId: string; title?: string; artist?: string; thumbnail?: string | null },
): Promise<void> {
  await ensureUserPlays(db);
  await db
    .prepare(
      `INSERT INTO user_track_stats (user_id, video_id, title, artist, thumbnail, plays, last_played_at)
       VALUES (?,?,?,?,?,1,?)
       ON CONFLICT(user_id, video_id) DO UPDATE SET
         plays = plays + 1,
         last_played_at = excluded.last_played_at,
         title = COALESCE(excluded.title, title),
         artist = COALESCE(excluded.artist, artist),
         thumbnail = COALESCE(excluded.thumbnail, thumbnail)`,
    )
    .bind(userId, t.videoId, t.title ?? null, t.artist ?? null, t.thumbnail ?? null, now())
    .run();
}

/** A user's most-played tracks, highest first (the profile's top songs). */
export async function getTopTracks(db: D1Database, userId: string, limit = 12): Promise<TopTrack[]> {
  await ensureUserPlays(db);
  const r = await db
    .prepare(
      `SELECT video_id, title, artist, thumbnail, plays
       FROM user_track_stats WHERE user_id = ?
       ORDER BY plays DESC, last_played_at DESC LIMIT ?`,
    )
    .bind(userId, Math.min(Math.max(limit, 1), 50))
    .all<{ video_id: string; title: string | null; artist: string | null; thumbnail: string | null; plays: number }>();
  return (r.results ?? []).map((row) => ({
    videoId: row.video_id,
    title: row.title || "",
    artist: row.artist || "",
    thumbnail: row.thumbnail,
    plays: row.plays,
  }));
}
