-- Bug reports: one row per user-triggered report from Settings ▸ Debug. Conservative capture —
-- build SHA + platform + the user's words + the engine/session snapshot + a bounded event ring +
-- stem-separation breadcrumbs. No PCM, no PII beyond the (nullable) account. The read side lives
-- only in the Access-gated admin worker.
CREATE TABLE IF NOT EXISTS bug_reports (
  id          TEXT PRIMARY KEY,          -- client-generated uuid (INSERT OR IGNORE dedupes retries)
  created_at  INTEGER NOT NULL,          -- server epoch ms
  account_id  TEXT,                      -- nullable: anonymous reports allowed
  version     TEXT NOT NULL,             -- build SHA — which code was running (load-bearing)
  platform    TEXT NOT NULL,             -- json: ua / mobile / screen / lang
  description TEXT,                       -- the user's sentence
  snapshot    TEXT NOT NULL,             -- json: the Settings-debug sections (engine/session/device)
  events      TEXT,                       -- json: the flight-recorder ring (bounded)
  stem_trace  TEXT,                       -- separation breadcrumbs, if any
  url         TEXT,
  resolved    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_bug_reports_created ON bug_reports (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bug_reports_account ON bug_reports (account_id);
