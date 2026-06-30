// In-app notifications — the durable event feed (Epic I). Point-in-time 1:1 events (v1: a new
// follower) are written here when they happen; the "people you follow are live" half is
// fan-out-on-read (liveFollowedRooms in rooms.ts) and stores nothing. The actor is resolved to
// a FRESH public card at read time (JOIN users), so a rename/avatar-change reflects and there's
// no stale payload. Read state is one per-user `seen_at` cursor — see migration 0019. Tables are
// runtime-ensured (mirrors ensureUserPlays) so this works before the migration is applied.
import { type D1Database, now } from "./core";

let ensured = false;
async function ensure(db: D1Database): Promise<void> {
  if (ensured) return;
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS notifications (
         id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, kind TEXT NOT NULL,
         actor_id TEXT, payload TEXT, created_at INTEGER NOT NULL)`,
    )
    .run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at)").run();
  await db.prepare("CREATE TABLE IF NOT EXISTS notif_seen (user_id TEXT PRIMARY KEY, seen_at INTEGER NOT NULL)").run();
  ensured = true;
}

export interface NotifEvent {
  id: number;
  kind: string;
  createdAt: number;
  actor: { handle: string | null; displayName: string | null; avatar: string | null };
  payload: string | null;
  followsBack: boolean; // does the RECIPIENT already follow the actor? (drives the bell's Follow-back affordance)
}

// Collapse repeat events from the same actor: an unfollow→refollow loop (or a spam-tap invite)
// can't re-ring the bell more than once per window. Actor-less/system events are never deduped.
const NOTIF_DEDUP_MS = 6 * 3_600_000;

/** Record a notification for `userId`. Best-effort — a notify failure must never break the
 *  action that triggered it (e.g. the follow still succeeds if this throws). Deduped per
 *  (recipient, actor, kind) within NOTIF_DEDUP_MS so it can't be used as a flooding vector. */
export async function addNotification(
  db: D1Database,
  n: { userId: string; kind: string; actorId?: string | null; payload?: string | null },
): Promise<void> {
  await ensure(db);
  if (n.actorId) {
    const dup = await db
      .prepare("SELECT 1 FROM notifications WHERE user_id=? AND kind=? AND actor_id=? AND created_at>? LIMIT 1")
      .bind(n.userId, n.kind, n.actorId, now() - NOTIF_DEDUP_MS)
      .first();
    if (dup) return; // already rang for this actor+kind recently — suppress the repeat
  }
  await db
    .prepare("INSERT INTO notifications (user_id, kind, actor_id, payload, created_at) VALUES (?,?,?,?,?)")
    .bind(n.userId, n.kind, n.actorId ?? null, n.payload ?? null, now())
    .run();
}

/** A user's recent notifications, newest first, with the actor resolved to a fresh card. */
export async function listNotifications(db: D1Database, userId: string, limit = 30): Promise<NotifEvent[]> {
  await ensure(db);
  const r = await db
    .prepare(
      `SELECT n.id, n.kind, n.created_at AS createdAt, n.payload,
              u.handle, u.display_name AS displayName, COALESCE(u.avatar_url, u.avatar) AS avatar,
              EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = n.user_id AND f.followee_id = n.actor_id) AS followsBack
       FROM notifications n LEFT JOIN users u ON u.id = n.actor_id
       WHERE n.user_id = ? ORDER BY n.created_at DESC LIMIT ?`,
    )
    .bind(userId, Math.max(1, Math.min(limit, 100)))
    .all<{ id: number; kind: string; createdAt: number; payload: string | null; handle: string | null; displayName: string | null; avatar: string | null; followsBack: number }>();
  return (r.results ?? []).map((x) => ({
    id: x.id,
    kind: x.kind,
    createdAt: x.createdAt,
    payload: x.payload,
    actor: { handle: x.handle, displayName: x.displayName, avatar: x.avatar },
    followsBack: !!x.followsBack,
  }));
}

/** The user's read cursor (last time they opened the bell), 0 if never. */
export async function getNotifSeenAt(db: D1Database, userId: string): Promise<number> {
  await ensure(db);
  const r = await db.prepare("SELECT seen_at FROM notif_seen WHERE user_id = ?").bind(userId).first<{ seen_at: number }>();
  return r?.seen_at ?? 0;
}

/** Stamp the read cursor (clears the unread badge across the user's devices). */
export async function setNotifSeenAt(db: D1Database, userId: string, ts: number): Promise<void> {
  await ensure(db);
  await db
    .prepare("INSERT INTO notif_seen (user_id, seen_at) VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET seen_at = excluded.seen_at")
    .bind(userId, ts)
    .run();
}
