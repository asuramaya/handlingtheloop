// Per-user synced data: the UI settings blob + play stats ("top songs").
import { resolveTrackName } from "../trackName";
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

// --- Per-user library blob (Collection + Playlists, synced across devices) -------
// Same shape + LWW policy as user_settings, but a SEPARATE row so a big library can't
// bloat (or race) the small UI-settings blob. Ensured at runtime so it works before the
// migration is applied to an existing DB (mirrors ensureUserPlays).
let ensuredLibrary = false;
async function ensureUserLibrary(db: D1Database): Promise<void> {
  if (ensuredLibrary) return;
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS user_library (
         user_id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL)`,
    )
    .run();
  ensuredLibrary = true;
}

/** The signed-in user's synced library blob (JSON string), or null if never saved. */
export async function getUserLibrary(
  db: D1Database,
  userId: string,
): Promise<{ data: string; updated_at: number } | null> {
  await ensureUserLibrary(db);
  return db
    .prepare("SELECT data, updated_at FROM user_library WHERE user_id = ?")
    .bind(userId)
    .first<{ data: string; updated_at: number }>();
}

/** Upsert the user's library blob (last-write-wins by the client-supplied timestamp). */
export async function putUserLibrary(db: D1Database, userId: string, data: string, updatedAt: number): Promise<void> {
  await ensureUserLibrary(db);
  // Conditional upsert: write only when the incoming value is BOTH newer AND different — a
  // stale or identical PUT (a cross-device adopt re-pushing the same blob) no-ops at the DB.
  await db
    .prepare(
      `INSERT INTO user_library (user_id, data, updated_at) VALUES (?,?,?)
       ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
         WHERE excluded.updated_at > user_library.updated_at AND excluded.data <> user_library.data`,
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

/** A user's most-played tracks, highest first (the profile's top songs).
 *
 *  ★ THE NAME IS RESOLVED, NOT REPRINTED. What this table stores is whatever the client happened
 *  to hold when the play was logged — which for a YouTube-sourced track is the UPLOADER's title
 *  and channel ("Deadmau5 - HR 8938 Cephei (1080p) || HD" by "TheOtherMau5"), and for a track
 *  loaded by bare id is nothing at all. The profile was printing both verbatim, so a public page
 *  showed raw video ids where song names belong.
 *
 *  The app already knows better and was never asked. Two joins, best evidence first:
 *    • track_identity — Chromaprint → AcoustID → MusicBrainz, the canonical artist/title. This is
 *      the actual resolution from a video id to a song.
 *    • community_tracks — the cached-catalogue index, which carries title/artist for anything
 *      anyone has loaded. It is what rescues the rows stored with NO metadata, since a track you
 *      played is a track that got cached.
 *  Anything still unresolved goes through resolveTrackName's conventions, and an id is never a
 *  name — see server/trackName.ts.
 *
 *  Both joins are LEFT: a profile must render with neither table populated. */
export async function getTopTracks(db: D1Database, userId: string, limit = 12): Promise<TopTrack[]> {
  await ensureUserPlays(db);
  const r = await db
    .prepare(
      `SELECT s.video_id, s.title, s.artist, s.thumbnail, s.plays,
              i.artist AS id_artist, i.title AS id_title,
              c.title  AS c_title,  c.artist AS c_artist, c.thumbnail AS c_thumb
       FROM user_track_stats s
       LEFT JOIN track_identity  i ON i.video_id = s.video_id
       LEFT JOIN community_tracks c ON c.video_id = s.video_id
       WHERE s.user_id = ?
       ORDER BY s.plays DESC, s.last_played_at DESC, s.video_id DESC LIMIT ?`,
    )
    .bind(userId, Math.min(Math.max(limit, 1), 50))
    .all<{
      video_id: string;
      title: string | null;
      artist: string | null;
      thumbnail: string | null;
      plays: number;
      id_artist: string | null;
      id_title: string | null;
      c_title: string | null;
      c_artist: string | null;
      c_thumb: string | null;
    }>();
  return (r.results ?? []).map((row) => {
    const named = resolveTrackName({
      identityArtist: row.id_artist,
      identityTitle: row.id_title,
      // The community index is the better of the two stored strings when the play carried none.
      title: row.title || row.c_title,
      artist: row.artist || row.c_artist,
    });
    return {
      videoId: row.video_id,
      title: named.title,
      artist: named.artist,
      thumbnail: row.thumbnail || row.c_thumb,
      plays: row.plays,
    };
  });
}
