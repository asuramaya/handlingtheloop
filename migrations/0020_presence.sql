-- Presence + friend-jam invites (the "play with a friend" door). `presence` is one row per
-- user, TRANSITION-written (online on a WS upgrade, offline when their last socket drops) — no
-- heartbeat, so it stays off the DO write-quota cliff. `updated_at` is an LWW guard: the offline
-- write only lands if nothing newer happened (a reconnect-elsewhere bumps it and wins). Read is a
-- mutual-follow ⋈ presence JOIN (friends only). `session_invites` is the short-lived push-invite
-- grant: a host invites a specific mutual, who is then auto-admitted (no second approval) when
-- they tap Join — consumed on use, treated stale after ~1h.
CREATE TABLE IF NOT EXISTS presence (
  user_id    TEXT PRIMARY KEY,
  online      INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_presence_online ON presence(online, updated_at);

CREATE TABLE IF NOT EXISTS session_invites (
  host_id    TEXT NOT NULL,    -- who invited (the room owner)
  guest_id   TEXT NOT NULL,    -- the invited mutual (auto-admitted on arrival)
  created_at INTEGER NOT NULL,
  PRIMARY KEY (host_id, guest_id)
);
