-- Per-account sampler files: the 4 GLOBAL pads on the sampler strip hold uploaded
-- audio (≤30s, ≤12MB), routed to master. Deck-region pads ("play X→Y" of a loaded
-- track) are positions only and live client-side, so they're NOT here. One row per
-- (user, pad) — uploading to a pad replaces its previous file, so a user holds at
-- most 4 rows. Bytes live in R2 at `samples/{user_id}/{id}`; this indexes them.
-- Mirrored by ensureUserSamples() in server/samples.ts so it exists on older DBs.
CREATE TABLE IF NOT EXISTS user_samples (
  id            TEXT PRIMARY KEY,      -- uuid; also the R2 object name
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pad           TEXT NOT NULL,         -- global pad slot: "g0".."g3"
  name          TEXT NOT NULL,
  r2_key        TEXT NOT NULL,         -- `samples/{user_id}/{id}`
  content_type  TEXT,
  duration_ms   INTEGER,
  bytes         INTEGER,
  created_at    INTEGER NOT NULL,
  UNIQUE (user_id, pad)
);
CREATE INDEX IF NOT EXISTS idx_user_samples_user ON user_samples(user_id);
