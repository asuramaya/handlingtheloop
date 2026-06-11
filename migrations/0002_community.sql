-- Community track index: the browsable catalog of what's cached, decoupled from
-- the R2 bucket listing. Replaces the per-request `AUDIO.list()` scan with an
-- indexed, ordered, paginated query — and is the single-row takedown lever.
-- Apply with:  wrangler d1 migrations apply htl-db [--remote]

CREATE TABLE IF NOT EXISTS community_tracks (
  video_id     TEXT PRIMARY KEY,           -- YouTube id (also the R2 audio key `a/<id>`)
  content_hash TEXT,                        -- reserved: PCM fingerprint for source-agnostic keying
  title        TEXT NOT NULL DEFAULT '',
  artist       TEXT,
  duration     INTEGER NOT NULL DEFAULT 0,  -- seconds
  thumbnail    TEXT,
  plays        INTEGER NOT NULL DEFAULT 0,
  cached_at    INTEGER NOT NULL,            -- epoch ms first seen
  updated_at   INTEGER NOT NULL
);

-- Newest-first browse + pagination.
CREATE INDEX IF NOT EXISTS idx_community_cached ON community_tracks(cached_at DESC);
