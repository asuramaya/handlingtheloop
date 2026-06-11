-- Per-account UI settings (the @htl Settings blob), synced across a user's devices.
-- Last-write-wins by `updated_at` (ms epoch from the client at save time).
CREATE TABLE IF NOT EXISTS user_settings (
  user_id    TEXT PRIMARY KEY,
  data       TEXT NOT NULL,    -- JSON-serialized Settings
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
