-- htl SaaS layer: accounts + connected services + playlist sync.
-- D1 (SQLite). Apply with:  wrangler d1 migrations apply htl-db [--remote]

CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,        -- uuid
  google_sub  TEXT UNIQUE,             -- stable Google account id (login identity)
  email       TEXT,
  name        TEXT,
  avatar      TEXT,
  created_at  INTEGER NOT NULL,        -- epoch ms
  last_login  INTEGER NOT NULL
);

-- One row per (user, service). Tokens are AES-GCM encrypted at rest (see crypto.ts).
CREATE TABLE IF NOT EXISTS connections (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider         TEXT NOT NULL,      -- 'google' | 'spotify'
  provider_user_id TEXT,               -- account id on that service
  access_token     TEXT NOT NULL,      -- encrypted
  refresh_token    TEXT,               -- encrypted
  expires_at       INTEGER,            -- epoch ms (access token)
  scope            TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  UNIQUE(user_id, provider)
);

-- Server sessions; the id is the httpOnly cookie value.
CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);

-- A configured sync from one service playlist to another.
CREATE TABLE IF NOT EXISTS sync_pairs (
  id                   TEXT PRIMARY KEY,
  user_id              TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_provider      TEXT NOT NULL,
  source_playlist_id   TEXT NOT NULL,
  source_playlist_name TEXT,
  dest_provider        TEXT NOT NULL,
  dest_playlist_id     TEXT,           -- filled once created on the destination
  dest_playlist_name   TEXT,
  mode                 TEXT NOT NULL DEFAULT 'once',   -- 'once' | 'continuous'
  status               TEXT NOT NULL DEFAULT 'idle',
  last_synced_at       INTEGER,
  created_at           INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  pair_id   TEXT NOT NULL REFERENCES sync_pairs(id) ON DELETE CASCADE,
  ts        INTEGER NOT NULL,
  added     INTEGER NOT NULL DEFAULT 0,
  matched   INTEGER NOT NULL DEFAULT 0,
  unmatched INTEGER NOT NULL DEFAULT 0,
  detail    TEXT
);

CREATE INDEX IF NOT EXISTS idx_conn_user  ON connections(user_id);
CREATE INDEX IF NOT EXISTS idx_sess_user  ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_pairs_user ON sync_pairs(user_id);
