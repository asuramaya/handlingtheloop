// Admin: takedown audit + account control.
import { type D1Database, now } from "./core";
import { purgeAccount } from "./account";

export interface Takedown {
  id: number;
  video_id: string;
  reason: string | null;
  by_email: string;
  purged: number;
  ts: number;
}

/** Record a DMCA/moderation takedown for the audit trail. */
export async function logTakedown(
  db: D1Database,
  t: { videoId: string; reason: string | null; byEmail: string; purged: boolean },
): Promise<void> {
  await db
    .prepare("INSERT INTO takedowns (video_id, reason, by_email, purged, ts) VALUES (?,?,?,?,?)")
    .bind(t.videoId, t.reason ?? null, t.byEmail, t.purged ? 1 : 0, now())
    .run();
}

/** Recent takedowns, newest first. */
export async function listTakedowns(db: D1Database, limit = 100): Promise<Takedown[]> {
  const r = await db
    .prepare("SELECT id, video_id, reason, by_email, purged, ts FROM takedowns ORDER BY ts DESC LIMIT ?")
    .bind(Math.max(1, Math.min(limit, 500)))
    .all<Takedown>();
  return r.results ?? [];
}

export interface AdminUser {
  id: string;
  email: string | null;
  name: string | null;
  created_at: number;
  last_login: number;
  providers: string;
}

/** Fully remove an account (admin takedown). Delegates to the same complete cascade the
 *  self-serve delete uses (purgeAccount) so an admin delete no longer orphans the social
 *  tables — follows/blocks/rooms/sets/settings/library/stats/samples — the way the old
 *  four-table version did. R2 blob purge (set logs / samples) is the caller's concern. */
export async function deleteUser(db: D1Database, userId: string): Promise<void> {
  await purgeAccount(db, userId);
}

/** Set an account's moderation status. 'banned'/'suspended' → currentUser() treats them as
 *  signed-out everywhere (no follow/post/room/invite); 'active' restores. A ban also drops their
 *  live sessions so the lock-out is immediate, not next-request. (0021) */
export async function setAccountStatus(db: D1Database, userId: string, status: "active" | "suspended" | "banned"): Promise<void> {
  try {
    await db.prepare("ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active'").run();
  } catch {
    /* column exists */
  }
  await db.prepare("UPDATE users SET status = ? WHERE id = ?").bind(status, userId).run();
  if (status !== "active") await db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId).run();
}

// NOTE: the YouTube *streaming cookie* path (the account-grade credential) was
// REMOVED ENTIRELY (2026-06-22) — client paste UI, client store, the Worker's
// x-htl-yt-cookie accept, and the server-side use are all gone. The residential
// relay now handles the datacenter bot wall, so a full Google session never has to
// transit the Worker (see docs/security-handoff.md Tier 3). The `user_cookies`
// table (migration 0006) was never wired to a route; drop it in a later migration.

/** Accounts overview for the admin panel (with their linked services). */
export async function listUsers(db: D1Database, limit = 200): Promise<AdminUser[]> {
  const r = await db
    .prepare(
      `SELECT u.id, u.email, u.name, u.created_at, u.last_login,
              COALESCE(GROUP_CONCAT(c.provider), '') AS providers
       FROM users u LEFT JOIN connections c ON c.user_id = u.id
       GROUP BY u.id ORDER BY u.last_login DESC LIMIT ?`,
    )
    .bind(Math.max(1, Math.min(limit, 1000)))
    .all<AdminUser>();
  return r.results ?? [];
}
