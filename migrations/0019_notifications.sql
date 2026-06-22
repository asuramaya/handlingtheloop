-- In-app notifications (Epic I): the DURABLE event feed (point-in-time 1:1 events like a new
-- follower). The "people you follow are live" half is fan-out-on-READ (a JOIN of follows⋈rooms,
-- no rows here). `notif_seen` is the per-user read cursor (last time they opened the bell) — one
-- scalar that drives the unread badge for BOTH halves: events with created_at > seen_at, and
-- live-followed rooms with started_at > seen_at. Server-side so the badge is cross-device.
CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL,    -- the RECIPIENT
  kind       TEXT NOT NULL,    -- "follow" (v1); "mention" | "request" later via the DO→worker bridge
  actor_id   TEXT,             -- who triggered it (resolved to a fresh public card at read time)
  payload    TEXT,             -- optional JSON context (e.g. the room/set id) — unused for "follow"
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at);

CREATE TABLE IF NOT EXISTS notif_seen (
  user_id TEXT PRIMARY KEY,
  seen_at INTEGER NOT NULL
);
