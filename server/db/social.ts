// Social graph: follows + blocks (migration 0013).
import { type D1Database, now } from "./core";

let graphReady = false;
/** Create the graph tables/indexes on an older/local DB that predates 0013. */
export async function ensureGraphTables(db: D1Database): Promise<void> {
  if (graphReady) return;
  await db
    .prepare(
      "CREATE TABLE IF NOT EXISTS follows (follower_id TEXT NOT NULL, followee_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (follower_id, followee_id))",
    )
    .run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_follows_followee ON follows(followee_id)").run();
  await db
    .prepare(
      "CREATE TABLE IF NOT EXISTS blocks (blocker_id TEXT NOT NULL, blocked_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (blocker_id, blocked_id))",
    )
    .run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_blocks_blocked ON blocks(blocked_id)").run();
  graphReady = true;
}

/** A minimal public card for follower/following lists. */
export interface PublicCard {
  handle: string | null;
  displayName: string | null;
  avatar: string | null;
}

/** True if EITHER user has blocked the other (the gate for following/interaction). */
export async function blockedEither(db: D1Database, a: string, b: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 FROM blocks WHERE (blocker_id=? AND blocked_id=?) OR (blocker_id=? AND blocked_id=?) LIMIT 1")
    .bind(a, b, b, a)
    .first();
  return !!row;
}

export type GraphResult = { ok: true } | { ok: false; reason: string };

/** follower follows followee. Rejects self-follow and either-way blocks. Idempotent. */
export async function followUser(db: D1Database, followerId: string, followeeId: string): Promise<GraphResult> {
  if (followerId === followeeId) return { ok: false, reason: "can't follow yourself" };
  if (await blockedEither(db, followerId, followeeId)) return { ok: false, reason: "unavailable" };
  await db
    .prepare("INSERT OR IGNORE INTO follows (follower_id, followee_id, created_at) VALUES (?,?,?)")
    .bind(followerId, followeeId, now())
    .run();
  return { ok: true };
}

export async function unfollowUser(db: D1Database, followerId: string, followeeId: string): Promise<void> {
  await db.prepare("DELETE FROM follows WHERE follower_id=? AND followee_id=?").bind(followerId, followeeId).run();
}

/** Block: record it AND drop any follow edge in BOTH directions. */
export async function blockUser(db: D1Database, blockerId: string, blockedId: string): Promise<GraphResult> {
  if (blockerId === blockedId) return { ok: false, reason: "can't block yourself" };
  await db
    .prepare("INSERT OR IGNORE INTO blocks (blocker_id, blocked_id, created_at) VALUES (?,?,?)")
    .bind(blockerId, blockedId, now())
    .run();
  await db
    .prepare("DELETE FROM follows WHERE (follower_id=? AND followee_id=?) OR (follower_id=? AND followee_id=?)")
    .bind(blockerId, blockedId, blockedId, blockerId)
    .run();
  return { ok: true };
}

export async function unblockUser(db: D1Database, blockerId: string, blockedId: string): Promise<void> {
  await db.prepare("DELETE FROM blocks WHERE blocker_id=? AND blocked_id=?").bind(blockerId, blockedId).run();
}

/** Follower + following counts for a user. */
export async function followCounts(db: D1Database, userId: string): Promise<{ followers: number; following: number }> {
  const f = await db.prepare("SELECT COUNT(*) AS n FROM follows WHERE followee_id=?").bind(userId).first<{ n: number }>();
  const g = await db.prepare("SELECT COUNT(*) AS n FROM follows WHERE follower_id=?").bind(userId).first<{ n: number }>();
  return { followers: f?.n ?? 0, following: g?.n ?? 0 };
}

/** The viewer's relationship to a target (drives the profile's Follow/Blocked UI). */
export interface Relationship {
  following: boolean; // viewer → target
  followedBy: boolean; // target → viewer
  mutual: boolean; // friends
  blocking: boolean; // viewer blocked target
  blockedBy: boolean; // target blocked viewer
}
export async function relationship(db: D1Database, viewerId: string, targetId: string): Promise<Relationship> {
  const one = async (sql: string, ...b: string[]) => !!(await db.prepare(sql).bind(...b).first());
  const [following, followedBy, blocking, blockedBy] = await Promise.all([
    one("SELECT 1 FROM follows WHERE follower_id=? AND followee_id=? LIMIT 1", viewerId, targetId),
    one("SELECT 1 FROM follows WHERE follower_id=? AND followee_id=? LIMIT 1", targetId, viewerId),
    one("SELECT 1 FROM blocks WHERE blocker_id=? AND blocked_id=? LIMIT 1", viewerId, targetId),
    one("SELECT 1 FROM blocks WHERE blocker_id=? AND blocked_id=? LIMIT 1", targetId, viewerId),
  ]);
  return { following, followedBy, mutual: following && followedBy, blocking, blockedBy };
}

/** Lean single-query "does follower → followee?" — used on the WS upgrade hot path (the room
 *  DO has no DB, so the Worker resolves the follow edge once and hands it to the DO as a flag). */
export async function isFollowing(db: D1Database, followerId: string, followeeId: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 FROM follows WHERE follower_id=? AND followee_id=? LIMIT 1")
    .bind(followerId, followeeId)
    .first();
  return !!row;
}

/** Followers of a user (most recent first), as public cards. */
export async function followersOf(db: D1Database, userId: string, limit = 50, offset = 0): Promise<PublicCard[]> {
  const r = await db
    .prepare(
      `SELECT u.handle, u.display_name AS displayName, u.avatar_url AS avatar
       FROM follows f JOIN users u ON u.id = f.follower_id
       WHERE f.followee_id=? AND u.handle IS NOT NULL
       ORDER BY f.created_at DESC LIMIT ? OFFSET ?`,
    )
    .bind(userId, limit, offset)
    .all<PublicCard>();
  return r.results ?? [];
}

/** Who a user follows (most recent first), as public cards. */
export async function followingOf(db: D1Database, userId: string, limit = 50, offset = 0): Promise<PublicCard[]> {
  const r = await db
    .prepare(
      `SELECT u.handle, u.display_name AS displayName, u.avatar_url AS avatar
       FROM follows f JOIN users u ON u.id = f.followee_id
       WHERE f.follower_id=? AND u.handle IS NOT NULL
       ORDER BY f.created_at DESC LIMIT ? OFFSET ?`,
    )
    .bind(userId, limit, offset)
    .all<PublicCard>();
  return r.results ?? [];
}
