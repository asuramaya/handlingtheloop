-- Privacy, moderation & private-accounts (audit hardening, 2026-06-30).
-- Adds: opt-in private/unlisted accounts + presence hiding; an account moderation status
-- (ban/suspend); a first-class reported-user target (so a moderator can pivot from a report
-- to the account); and the follow-request queue that a private account approves from.
-- The users columns are also mirrored at runtime by ensureIdentityColumns() for older/local DBs.
-- Apply with:  wrangler d1 migrations apply htl-db [--remote]

ALTER TABLE users ADD COLUMN private       INTEGER NOT NULL DEFAULT 0; -- unlisted from search/suggest + follow-approval
ALTER TABLE users ADD COLUMN hide_presence INTEGER NOT NULL DEFAULT 0; -- never expose `online`, even to friends
ALTER TABLE users ADD COLUMN status        TEXT    NOT NULL DEFAULT 'active'; -- 'active' | 'suspended' | 'banned'

-- A report can now name the account it targets, not just free text — the moderator acts on it.
ALTER TABLE reports ADD COLUMN target_user TEXT;

-- Pending follow requests to a PRIVATE account (the approval queue). On approve the row moves
-- into `follows`; on deny it's deleted. A public account never creates these (instant follow).
CREATE TABLE IF NOT EXISTS follow_requests (
  requester_id TEXT NOT NULL,
  target_id    TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (requester_id, target_id)
);
CREATE INDEX IF NOT EXISTS idx_follow_requests_target ON follow_requests(target_id, created_at);
