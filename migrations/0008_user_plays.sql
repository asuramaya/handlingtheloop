-- Per-user play stats — the profile "top songs". An aggregate (one row per
-- user+track with a running count), not an append-only log, so "top N" is a cheap
-- indexed query and the table can't grow unbounded. Mirrored by ensureUserPlays()
-- in server/db.ts so it also exists on DBs created before this migration ran.
CREATE TABLE IF NOT EXISTS user_track_stats (
  user_id        TEXT    NOT NULL,
  video_id       TEXT    NOT NULL,
  title          TEXT,
  artist         TEXT,
  thumbnail      TEXT,
  plays          INTEGER NOT NULL DEFAULT 0,
  last_played_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, video_id)
);
CREATE INDEX IF NOT EXISTS idx_user_track_plays ON user_track_stats(user_id, plays DESC);
