-- Room registry (Epic E1/E2): a D1 "shadow" of which accounts are broadcasting a
-- PUBLIC room right now, so the live directory can be QUERIED (you can't query the
-- Durable Objects). The DjRoom DO has no D1 binding, so the HOST'S client announces
-- its live state here (go-public + a periodic heartbeat); `last_seen` ages a room
-- out of the directory if the host vanishes (E11 zombie cleanup = freshness filter).
-- One row per host = their single home room. Joined to users for handle/avatar.
CREATE TABLE IF NOT EXISTS rooms (
  host_id     TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  title       TEXT,
  genre       TEXT,
  live        INTEGER NOT NULL DEFAULT 0, -- 1 = currently broadcasting + heartbeating
  listeners   INTEGER NOT NULL DEFAULT 0, -- last reported crowd size (from the DO presence count)
  np_title    TEXT,                       -- now playing (for the directory card)
  np_artist   TEXT,
  np_video    TEXT,
  started_at  INTEGER,                    -- epoch ms this broadcast began
  last_seen   INTEGER NOT NULL            -- epoch ms of the last heartbeat; stale → hidden
);
CREATE INDEX IF NOT EXISTS idx_rooms_live ON rooms(live, last_seen);
