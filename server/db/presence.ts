// Presence ("is my friend online right now?") + the friend-jam invite grant. Presence is the
// missing primitive for CO-PLAY: the mutual-follow edge existed but carried no live state, so
// playing with a friend meant going fully public or hand-carrying a link. Here a user is "online"
// the moment any authenticated socket attaches (own rig, a jam, or a signed-in listen), and
// "offline" once their last socket drops (bridged up from the room DO, which has no D1 — see
// /internal/presence). Reads are MUTUAL-only (friends), blocks-excluded, with `live` derived from
// the rooms row so we never fork liveness. Tables are runtime-ensured (mirrors notifications.ts)
// so this works before migration 0020 is applied. See migration 0020.
import { type D1Database, now } from "./core";

// Safety-net TTL for the transition-written `online` flag. Presence is deliberately NOT
// heartbeated (it flips on socket-attach, off on the DO's last-close bridge — see the header) to
// stay off the DO write-quota cliff, so `updated_at` is the attach time, not a liveness ping.
// This window only reaps a row whose offline bridge never fired (DO evicted/crashed): a session
// open >24h continuously is not a meaningful "active now" signal anyway, and any WS reconnect in
// between bumps `updated_at`. Mirrors the rooms `last_seen` freshness pattern, just far looser.
export const PRESENCE_TTL_MS = 24 * 3_600_000;

let ensured = false;
export async function ensurePresenceTables(db: D1Database): Promise<void> {
  if (ensured) return;
  await db
    .prepare(
      "CREATE TABLE IF NOT EXISTS presence (user_id TEXT PRIMARY KEY, online INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)",
    )
    .run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_presence_online ON presence(online, updated_at)").run();
  await db
    .prepare(
      "CREATE TABLE IF NOT EXISTS session_invites (host_id TEXT NOT NULL, guest_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (host_id, guest_id))",
    )
    .run();
  ensured = true;
}

/** Mark a user online (any authed socket attached). Bumps `updated_at` — that timestamp is the
 *  LWW key the offline write checks against, so a fresh connection always beats a stale offline. */
export async function setPresenceOnline(db: D1Database, userId: string): Promise<void> {
  await ensurePresenceTables(db);
  await db
    .prepare(
      "INSERT INTO presence (user_id, online, updated_at) VALUES (?,1,?) ON CONFLICT(user_id) DO UPDATE SET online = 1, updated_at = excluded.updated_at",
    )
    .bind(userId, now())
    .run();
}

/** Mark a user offline — but ONLY if nothing newer happened. `since` is when the DO observed the
 *  last socket close; if the user reconnected anywhere after that, `updated_at` advanced past
 *  `since` and this no-ops (no stuck-offline, no cross-room race). */
export async function setPresenceOffline(db: D1Database, userId: string, since: number): Promise<void> {
  await ensurePresenceTables(db);
  await db
    .prepare("UPDATE presence SET online = 0, updated_at = ? WHERE user_id = ? AND online = 1 AND updated_at <= ?")
    .bind(now(), userId, since)
    .run();
}

/** Is one user online right now? (Any authed socket attached — i.e. reachable for a jam knock.)
 *  Drives the /@handle profile's "Knock to jam" affordance when the host is in a private session. */
export async function isPresenceOnline(db: D1Database, userId: string): Promise<boolean> {
  await ensurePresenceTables(db);
  const r = await db
    .prepare("SELECT online, updated_at FROM presence WHERE user_id = ?")
    .bind(userId)
    .first<{ online: number; updated_at: number }>();
  return !!r && r.online === 1 && r.updated_at > now() - PRESENCE_TTL_MS;
}

export interface FriendPresence {
  handle: string;
  displayName: string | null;
  avatar: string | null;
  live: boolean; // broadcasting right now (derived from the rooms row, not stored on presence)
}

/** Friends (MUTUAL follows) who are online right now, blocks-excluded both directions. `live` is
 *  LEFT-JOINed from the rooms directory (fresh broadcast) so we label "live" without a second
 *  liveness system. Mirrors liveFollowedRooms' blocks gate; the mutual edge is the self-join of
 *  follows (viewer→f AND f→viewer). */
export async function friendsOnline(db: D1Database, viewerId: string, freshMs = 90_000): Promise<FriendPresence[]> {
  await ensurePresenceTables(db);
  const cutoff = now() - freshMs;
  const presenceCutoff = now() - PRESENCE_TTL_MS;
  const r = await db
    .prepare(
      `SELECT u.handle, u.display_name AS displayName, COALESCE(u.avatar_url, u.avatar) AS avatar,
              (r.host_id IS NOT NULL) AS live
       FROM follows f1
       JOIN follows f2 ON f2.follower_id = f1.followee_id AND f2.followee_id = f1.follower_id
       JOIN presence p ON p.user_id = f1.followee_id
       JOIN users u ON u.id = f1.followee_id
       LEFT JOIN rooms r ON r.host_id = u.id AND r.live = 1 AND r.last_seen > ?
       WHERE f1.follower_id = ? AND p.online = 1 AND p.updated_at > ? AND u.handle IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM blocks b
           WHERE (b.blocker_id = f1.follower_id AND b.blocked_id = f1.followee_id)
              OR (b.blocker_id = f1.followee_id AND b.blocked_id = f1.follower_id))
       ORDER BY live DESC, u.handle ASC LIMIT 100`,
    )
    .bind(cutoff, viewerId, presenceCutoff)
    .all<{ handle: string; displayName: string | null; avatar: string | null; live: number }>();
  return (r.results ?? []).map((x) => ({
    handle: x.handle,
    displayName: x.displayName,
    avatar: x.avatar,
    live: !!x.live,
  }));
}

/** Record a push-invite grant: `hostId` invited `guestId` to jam → they're auto-admitted once. */
export async function addSessionInvite(db: D1Database, hostId: string, guestId: string): Promise<void> {
  await ensurePresenceTables(db);
  await db
    .prepare(
      "INSERT INTO session_invites (host_id, guest_id, created_at) VALUES (?,?,?) ON CONFLICT(host_id, guest_id) DO UPDATE SET created_at = excluded.created_at",
    )
    .bind(hostId, guestId, now())
    .run();
}

/** Consume a fresh push-invite grant (host→guest) on the jam WS upgrade. Returns true (and deletes
 *  the row) iff a non-stale grant existed, so the guest auto-joins; false → they land as a knock.
 *  TTL ~1h: an old invite shouldn't silently admit someone days later. */
export async function consumeSessionInvite(db: D1Database, hostId: string, guestId: string, ttlMs = 3_600_000): Promise<boolean> {
  await ensurePresenceTables(db);
  const row = await db
    .prepare("SELECT created_at FROM session_invites WHERE host_id = ? AND guest_id = ?")
    .bind(hostId, guestId)
    .first<{ created_at: number }>();
  if (!row) return false;
  await db.prepare("DELETE FROM session_invites WHERE host_id = ? AND guest_id = ?").bind(hostId, guestId).run();
  return now() - row.created_at <= ttlMs;
}
