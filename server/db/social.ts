// Social graph: follows + blocks (migration 0013).
import { type D1Database, now } from "./core";
import { addNotification } from "./notifications";
import { PRESENCE_TTL_MS } from "./presence";

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
  // Pending follow requests to a PRIVATE account (0021). Approve → moved into follows.
  await db
    .prepare(
      "CREATE TABLE IF NOT EXISTS follow_requests (requester_id TEXT NOT NULL, target_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (requester_id, target_id))",
    )
    .run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_follow_requests_target ON follow_requests(target_id, created_at)").run();
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

export type FollowState = "following" | "requested";

/** follower follows followee. Rejects self-follow and either-way blocks. Idempotent. If the
 *  target is PRIVATE and not already followed, this records a pending follow_request (approval
 *  queue) instead of an edge, and returns state:"requested". Otherwise it's an instant follow. */
export async function followUser(
  db: D1Database,
  followerId: string,
  followeeId: string,
): Promise<{ ok: false; reason: string } | { ok: true; state: FollowState }> {
  if (followerId === followeeId) return { ok: false, reason: "can't follow yourself" };
  if (await blockedEither(db, followerId, followeeId)) return { ok: false, reason: "unavailable" };
  const already = await db
    .prepare("SELECT 1 FROM follows WHERE follower_id=? AND followee_id=? LIMIT 1")
    .bind(followerId, followeeId)
    .first();
  if (already) return { ok: true, state: "following" };
  const target = await db.prepare("SELECT private FROM users WHERE id=?").bind(followeeId).first<{ private: number | null }>();
  if (target?.private) {
    await db
      .prepare("INSERT OR IGNORE INTO follow_requests (requester_id, target_id, created_at) VALUES (?,?,?)")
      .bind(followerId, followeeId, now())
      .run();
    await addNotification(db, { userId: followeeId, kind: "follow_request", actorId: followerId }).catch(() => {});
    return { ok: true, state: "requested" };
  }
  const res = await db
    .prepare("INSERT OR IGNORE INTO follows (follower_id, followee_id, created_at) VALUES (?,?,?)")
    .bind(followerId, followeeId, now())
    .run();
  // Notify only on a genuinely new edge (changes>0); a notify failure never fails the follow.
  if ((res.meta?.changes ?? 0) > 0) {
    await addNotification(db, { userId: followeeId, kind: "follow", actorId: followerId }).catch(() => {});
  }
  return { ok: true, state: "following" };
}

/** Approve a pending follow request → move it into `follows` + tell the requester. Returns false
 *  if no such request (already handled / never existed). */
export async function approveFollowRequest(db: D1Database, ownerId: string, requesterId: string): Promise<boolean> {
  const has = await db
    .prepare("SELECT 1 FROM follow_requests WHERE requester_id=? AND target_id=? LIMIT 1")
    .bind(requesterId, ownerId)
    .first();
  if (!has) return false;
  await db.prepare("DELETE FROM follow_requests WHERE requester_id=? AND target_id=?").bind(requesterId, ownerId).run();
  await db
    .prepare("INSERT OR IGNORE INTO follows (follower_id, followee_id, created_at) VALUES (?,?,?)")
    .bind(requesterId, ownerId, now())
    .run();
  await addNotification(db, { userId: requesterId, kind: "follow_accepted", actorId: ownerId }).catch(() => {});
  return true;
}

/** Deny / withdraw a pending follow request (no notification — silent). */
export async function denyFollowRequest(db: D1Database, ownerId: string, requesterId: string): Promise<void> {
  await db.prepare("DELETE FROM follow_requests WHERE requester_id=? AND target_id=?").bind(requesterId, ownerId).run();
}

/** Pending incoming follow requests for an account (the approval inbox), enriched. */
export async function listFollowRequests(db: D1Database, ownerId: string): Promise<PersonCard[]> {
  const r = await db
    .prepare(
      `SELECT u.id, u.handle, u.display_name AS displayName, u.avatar_url AS avatar
       FROM follow_requests fr JOIN users u ON u.id = fr.requester_id
       WHERE fr.target_id=? AND u.handle IS NOT NULL ORDER BY fr.created_at DESC LIMIT 100`,
    )
    .bind(ownerId)
    .all<BaseRow>();
  return enrich(db, r.results ?? [], ownerId);
}

/** Count of pending incoming follow requests (drives a badge). */
export async function followRequestCount(db: D1Database, ownerId: string): Promise<number> {
  const r = await db.prepare("SELECT COUNT(*) AS n FROM follow_requests WHERE target_id=?").bind(ownerId).first<{ n: number }>();
  return Number(r?.n ?? 0);
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
  requested: boolean; // viewer has a PENDING follow request to a private target
}
export async function relationship(db: D1Database, viewerId: string, targetId: string): Promise<Relationship> {
  const one = async (sql: string, ...b: string[]) => !!(await db.prepare(sql).bind(...b).first());
  const [following, followedBy, blocking, blockedBy, requested] = await Promise.all([
    one("SELECT 1 FROM follows WHERE follower_id=? AND followee_id=? LIMIT 1", viewerId, targetId),
    one("SELECT 1 FROM follows WHERE follower_id=? AND followee_id=? LIMIT 1", targetId, viewerId),
    one("SELECT 1 FROM blocks WHERE blocker_id=? AND blocked_id=? LIMIT 1", viewerId, targetId),
    one("SELECT 1 FROM blocks WHERE blocker_id=? AND blocked_id=? LIMIT 1", targetId, viewerId),
    one("SELECT 1 FROM follow_requests WHERE requester_id=? AND target_id=? LIMIT 1", viewerId, targetId),
  ]);
  return { following, followedBy, mutual: following && followedBy, blocking, blockedBy, requested };
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

/** An ACTIONABLE person card: the public identity PLUS the viewer-relative state every people
 *  surface (search results, follower/following lists, suggestions) needs to render the right
 *  inline action and a presence dot — without a second round-trip per row. `online`/`live` are
 *  presence; `following`/`followsYou` are the viewer's edges (mutual = both). */
export interface PersonCard {
  handle: string | null;
  displayName: string | null;
  avatar: string | null;
  online: boolean; // any authed session attached (reachable for a jam knock)
  live: boolean; // broadcasting a fresh public room right now
  following: boolean; // viewer → them
  followsYou: boolean; // them → viewer
  isSelf: boolean; // this row IS the signed-in viewer (so the UI shows no self-action)
}

interface BaseRow {
  id: string;
  handle: string | null;
  displayName: string | null;
  avatar: string | null;
}

/** Phase 2 of every people query: take a page of base rows and decorate each with presence + the
 *  viewer's follow edges in FOUR bulk set-membership queries (not N per-row lookups). Cheap for a
 *  page ≤50; keeps the base queries simple (no correlated-subquery bind juggling). */
async function enrich(db: D1Database, rows: BaseRow[], viewerId: string): Promise<PersonCard[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const ph = ids.map(() => "?").join(",");
  const cutoff = now() - 90_000; // live-room freshness window (mirrors liveRooms/friendsOnline)
  const pCutoff = now() - PRESENCE_TTL_MS; // stuck-online safety net (mirrors isPresenceOnline)
  const setOf = async (sql: string, ...lead: (string | number)[]) => {
    const r = await db
      .prepare(sql)
      .bind(...lead, ...ids)
      .all<{ x: string }>();
    return new Set((r.results ?? []).map((o) => o.x));
  };
  const [online, live, following, followsYou] = await Promise.all([
    setOf(
      `SELECT p.user_id x FROM presence p JOIN users u ON u.id=p.user_id
       WHERE p.online=1 AND p.updated_at>? AND u.hide_presence=0 AND p.user_id IN (${ph})`,
      pCutoff,
    ),
    setOf(`SELECT host_id x FROM rooms WHERE live=1 AND last_seen>? AND host_id IN (${ph})`, cutoff),
    viewerId ? setOf(`SELECT followee_id x FROM follows WHERE follower_id=? AND followee_id IN (${ph})`, viewerId) : new Set<string>(),
    viewerId ? setOf(`SELECT follower_id x FROM follows WHERE followee_id=? AND follower_id IN (${ph})`, viewerId) : new Set<string>(),
  ]);
  return rows.map((r) => {
    const followsHim = following.has(r.id);
    const followsMe = followsYou.has(r.id);
    return {
      handle: r.handle,
      displayName: r.displayName,
      avatar: r.avatar,
      // Presence is FRIENDS-ONLY: only a mutual sees "online" (the live public-room signal is
      // separate + already public). A non-mutual / anonymous viewer never learns who's around.
      online: online.has(r.id) && followsHim && followsMe,
      live: live.has(r.id),
      following: followsHim,
      followsYou: followsMe,
      isSelf: viewerId !== "" && r.id === viewerId,
    };
  });
}

/** Followers of a user (most recent first), enriched + paginated. `viewerId` enriches each card
 *  with the viewer's edges and drops anyone in a block relationship either way. */
export async function followersOf(db: D1Database, userId: string, limit = 50, offset = 0, viewerId = ""): Promise<PersonCard[]> {
  return listGraph(db, "follower", userId, limit, offset, viewerId);
}

/** Who a user follows (most recent first), enriched + paginated. */
export async function followingOf(db: D1Database, userId: string, limit = 50, offset = 0, viewerId = ""): Promise<PersonCard[]> {
  return listGraph(db, "followee", userId, limit, offset, viewerId);
}

async function listGraph(
  db: D1Database,
  side: "follower" | "followee",
  userId: string,
  limit: number,
  offset: number,
  viewerId: string,
): Promise<PersonCard[]> {
  // side=follower → people who follow userId; side=followee → people userId follows.
  const joinCol = side === "follower" ? "f.follower_id" : "f.followee_id";
  const whereCol = side === "follower" ? "f.followee_id" : "f.follower_id";
  const binds: (string | number)[] = [userId];
  let blockClause = "";
  if (viewerId) {
    blockClause =
      " AND u.id NOT IN (SELECT blocked_id FROM blocks WHERE blocker_id=?) AND u.id NOT IN (SELECT blocker_id FROM blocks WHERE blocked_id=?)";
    binds.push(viewerId, viewerId);
  }
  binds.push(limit, offset);
  const r = await db
    .prepare(
      `SELECT u.id, u.handle, u.display_name AS displayName, u.avatar_url AS avatar
       FROM follows f JOIN users u ON u.id = ${joinCol}
       WHERE ${whereCol}=? AND u.handle IS NOT NULL${blockClause}
       ORDER BY f.created_at DESC LIMIT ? OFFSET ?`,
    )
    .bind(...binds)
    .all<BaseRow>();
  return enrich(db, r.results ?? [], viewerId);
}

/** Global people search by handle or display name (prefix-weighted substring), enriched +
 *  paginated. `viewerId` (when signed in) drops the viewer themselves and anyone blocked either
 *  way, and ranks the page mutuals-first. LIKE-escaped so a literal `%`/`_` can't widen the match. */
export async function searchUsers(db: D1Database, q: string, viewerId = "", limit = 20, offset = 0): Promise<PersonCard[]> {
  // Cap the term: handles are ≤20 chars and display names are short, so a longer query can never
  // match more — and an overlong LIKE pattern trips SQLite's "pattern too complex" limit (~49
  // chars), which would otherwise surface as an unhandled D1 throw → a 502 on plain user input.
  const term = q.trim().slice(0, 40);
  if (term.length < 2) return [];
  const esc = term.replace(/[\\%_]/g, (c) => `\\${c}`); // neutralise LIKE wildcards
  const sub = `%${esc}%`;
  const pre = `${esc}%`;
  const binds: (string | number)[] = [sub, sub, viewerId]; // handle LIKE, display LIKE, id != self
  let blockClause = "";
  if (viewerId) {
    blockClause =
      " AND u.id NOT IN (SELECT blocked_id FROM blocks WHERE blocker_id=?)" +
      " AND u.id NOT IN (SELECT blocker_id FROM blocks WHERE blocked_id=?)";
    binds.push(viewerId, viewerId);
  }
  // PRIVATE accounts are unlisted: only surfaced to themselves or to someone who already follows
  // them. Anonymous viewer ("") never matches the self/follow exceptions → private fully hidden.
  binds.push(viewerId, viewerId);
  binds.push(pre, limit, offset); // ORDER prefix-first, then page
  try {
    const r = await db
      .prepare(
        `SELECT u.id, u.handle, u.display_name AS displayName, u.avatar_url AS avatar
         FROM users u
         WHERE u.handle IS NOT NULL
           AND (u.handle LIKE ? ESCAPE '\\' OR u.display_name LIKE ? ESCAPE '\\')
           AND u.id != ?${blockClause}
           AND (u.private = 0 OR u.id = ? OR EXISTS (SELECT 1 FROM follows ff WHERE ff.follower_id = ? AND ff.followee_id = u.id))
         ORDER BY CASE WHEN u.handle LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END, u.handle
         LIMIT ? OFFSET ?`,
      )
      .bind(...binds)
      .all<BaseRow>();
    const cards = await enrich(db, r.results ?? [], viewerId);
    // Float relationships up WITHIN the page: mutuals first, then people who already follow you.
    return cards.sort((a, b) => rankRel(b) - rankRel(a));
  } catch {
    // Defence in depth: any D1 hiccup (e.g. a pathological multibyte LIKE pattern that slips the
    // length cap) yields no results, never a 5xx — search is a non-critical, best-effort surface.
    return [];
  }
}
const rankRel = (c: PersonCard) => (c.following && c.followsYou ? 2 : c.followsYou ? 1 : 0);

/** "People you may know": 2nd-degree connections (friends-of-friends you don't yet follow),
 *  ranked by how many of your follows lead to them, topped up with popular accounts when the
 *  graph is sparse. Signed-out → popular only. Enriched like every other people card. */
export async function suggestedUsers(db: D1Database, viewerId = "", limit = 12): Promise<PersonCard[]> {
  if (!viewerId) return popularUsers(db, "", limit);
  const r = await db
    .prepare(
      `SELECT u.id, u.handle, u.display_name AS displayName, u.avatar_url AS avatar,
              COUNT(DISTINCT f1.followee_id) AS via
       FROM follows f1
       JOIN follows f2 ON f2.follower_id = f1.followee_id
       JOIN users u ON u.id = f2.followee_id
       WHERE f1.follower_id=? AND u.id!=? AND u.handle IS NOT NULL AND u.private=0
         AND NOT EXISTS (SELECT 1 FROM follows fe WHERE fe.follower_id=? AND fe.followee_id=u.id)
         AND u.id NOT IN (SELECT blocked_id FROM blocks WHERE blocker_id=?)
         AND u.id NOT IN (SELECT blocker_id FROM blocks WHERE blocked_id=?)
       GROUP BY u.id
       ORDER BY via DESC LIMIT ?`,
    )
    .bind(viewerId, viewerId, viewerId, viewerId, viewerId, limit)
    .all<BaseRow>();
  let cards = await enrich(db, r.results ?? [], viewerId);
  if (cards.length < limit) {
    const seen = new Set(cards.map((c) => c.handle));
    const pop = await popularUsers(db, viewerId, limit - cards.length, seen);
    cards = cards.concat(pop);
  }
  return cards;
}

/** Most-followed accounts (the cold-start / sparse-graph fallback for suggestions), excluding the
 *  viewer, anyone they already follow, blocks, and a caller-supplied exclude set. */
async function popularUsers(db: D1Database, viewerId: string, limit: number, exclude = new Set<string | null>()): Promise<PersonCard[]> {
  const binds: (string | number)[] = [];
  let where = "u.handle IS NOT NULL AND u.private=0"; // private accounts are never "suggested"
  if (viewerId) {
    where +=
      " AND u.id!=? AND NOT EXISTS (SELECT 1 FROM follows fe WHERE fe.follower_id=? AND fe.followee_id=u.id)" +
      " AND u.id NOT IN (SELECT blocked_id FROM blocks WHERE blocker_id=?) AND u.id NOT IN (SELECT blocker_id FROM blocks WHERE blocked_id=?)";
    binds.push(viewerId, viewerId, viewerId, viewerId);
  }
  binds.push(limit + exclude.size); // over-fetch so the JS exclude-filter still returns `limit`
  const r = await db
    .prepare(
      `SELECT u.id, u.handle, u.display_name AS displayName, u.avatar_url AS avatar
       FROM users u
       WHERE ${where}
       ORDER BY (SELECT COUNT(*) FROM follows ff WHERE ff.followee_id=u.id) DESC, u.created_at DESC
       LIMIT ?`,
    )
    .bind(...binds)
    .all<BaseRow>();
  const rows = (r.results ?? []).filter((row) => !exclude.has(row.handle)).slice(0, limit);
  return enrich(db, rows, viewerId);
}
