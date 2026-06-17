-- 0015: moderation reports (L2). Users file reports from the app; the admin worker reads the
-- open queue and resolves them. Shares htl-db with the rest of the system.
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,          -- "room" | "chat" | "user"
  room TEXT,                   -- host @handle the report is about (context)
  target_dev TEXT,             -- reported device id (chat/user), if any
  target_text TEXT,            -- snapshot of the reported message, if any
  reporter TEXT NOT NULL,      -- user id, or anon:<ip>
  reason TEXT,                 -- optional free-text reason
  ts INTEGER NOT NULL,
  resolved INTEGER NOT NULL DEFAULT 0,
  resolved_by TEXT,
  resolved_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_reports_open ON reports (resolved, ts);
