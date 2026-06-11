-- The signed-in user's YouTube streaming cookie, ENCRYPTED at rest (crypto.ts, same
-- key as the OAuth tokens). Synced across the account's devices: the minimal cookie
-- header the player needs (parseCookieInput already trims it to the auth/visitor set).
CREATE TABLE IF NOT EXISTS user_cookies (
  user_id    TEXT PRIMARY KEY,
  cookie     TEXT NOT NULL,     -- AES-encrypted cookie header
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
