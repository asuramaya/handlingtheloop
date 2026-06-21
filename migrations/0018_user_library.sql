-- Per-account library blob (the rekordbox-style Collection + Playlists), synced across a
-- user's devices. Mirrors user_settings: a single JSON blob, last-write-wins by `updated_at`
-- (ms epoch from the client at save time). Audio bytes are NOT here — they live in R2 / the
-- device IndexedDB cache; this is only the curation (which tracks, which playlists, in order).
CREATE TABLE IF NOT EXISTS user_library (
  user_id    TEXT PRIMARY KEY,
  data       TEXT NOT NULL,    -- JSON-serialized { collection, playlists }
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
