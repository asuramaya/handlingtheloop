-- ISRC → videoId resolution memo for the auto-mix provider-radio tier.
--
-- TIDAL's track radio returns catalogue tracks; a deck needs a YouTube videoId. Resolving one
-- costs a YouTube search, and the old inline implementation did that for EVERY result of EVERY
-- seed on every fill — up to two dozen searches on a single /api/recommend, which is both slow
-- and over a Worker's comfortable subrequest budget. An ISRC identifies a specific recording
-- permanently, so the mapping never goes stale: resolve once, keep forever.
--
-- Distinct from `track_identity`, which maps the other way (video_id → isrc) and only ever covers
-- videos we have fingerprinted ourselves. Nothing in that table can answer "which video IS this
-- catalogue track", which is the question this one exists for.
CREATE TABLE IF NOT EXISTS isrc_video (
  isrc       TEXT PRIMARY KEY,
  video_id   TEXT NOT NULL,
  title      TEXT,
  artist     TEXT,
  updated_at INTEGER NOT NULL
);

-- Reverse lookups ("what else resolved to this video") for dedup + admin coverage checks.
CREATE INDEX IF NOT EXISTS idx_isrc_video_video ON isrc_video(video_id);
