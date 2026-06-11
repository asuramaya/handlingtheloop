-- DMCA / moderation audit log. Every admin takedown is recorded (who, what, why,
-- when) for compliance. Lives in the same htl-db as the community index; written
-- only by the privileged admin worker.
-- Apply with:  wrangler d1 migrations apply htl-db [--remote]

CREATE TABLE IF NOT EXISTS takedowns (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id   TEXT NOT NULL,
  reason     TEXT,
  by_email   TEXT NOT NULL,        -- the authenticated admin (from Cloudflare Access)
  purged     INTEGER NOT NULL DEFAULT 0,  -- 1 if the R2 bytes were also deleted
  ts         INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_takedowns_video ON takedowns(video_id);
CREATE INDEX IF NOT EXISTS idx_takedowns_ts ON takedowns(ts DESC);
