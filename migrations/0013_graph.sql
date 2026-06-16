-- The social graph (Epic C): asymmetric FOLLOWS + BLOCKS. follower/followee and
-- blocker/blocked are account ids (users.id). Self-edges are rejected in code.
-- "Friends" = mutual follow, derived (no table). Mirrored by ensureGraphTables()
-- in server/db.ts for older/local DBs.

CREATE TABLE IF NOT EXISTS follows (
  follower_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, -- the one doing the following
  followee_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, -- the one being followed
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (follower_id, followee_id)         -- uniqueness + the "who X follows" index
);
-- "who follows X" + the follower COUNT. (C4 hot-row note: counts are COUNT(*) over
-- this index for now — fine at current scale; denormalize to a per-user counter
-- column if a single account ever reaches list sizes where COUNT(*) hurts.)
CREATE INDEX IF NOT EXISTS idx_follows_followee ON follows(followee_id);

CREATE TABLE IF NOT EXISTS blocks (
  blocker_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (blocker_id, blocked_id)
);
CREATE INDEX IF NOT EXISTS idx_blocks_blocked ON blocks(blocked_id);
