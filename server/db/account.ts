// Self-serve account deletion (M3). D1 does NOT enforce the `ON DELETE CASCADE` FK
// declarations (foreign-key pragma is off), so a delete must EXPLICITLY clear every
// per-user table — the admin `deleteUser` only cleared four and orphaned the whole
// social layer. This is the complete cascade: it gathers the user's R2 object keys
// (set logs + sample bytes) BEFORE deleting the index rows, removes every D1 row keyed
// to the user, frees the @handle (the users row is dropped → the name is reusable
// immediately, per policy), and anonymizes shared contributions rather than destroying
// them. Each auxiliary delete is best-effort: a table that a given DB never created
// (the runtime-ensured ones) must not abort the core deletion.
import type { D1Database } from "./core";

async function tryRun(db: D1Database, sql: string, ...binds: unknown[]): Promise<void> {
  try {
    await db.prepare(sql).bind(...binds).run();
  } catch {
    /* missing table (never ensured on this DB) or empty — deletion is best-effort */
  }
}

/** Fully remove an account from D1 and return the R2 keys the caller must also purge.
 *  Returns the user's set-log keys (`sets/<id>.json`) and sample keys (`samples/<uid>/<id>`). */
export async function purgeAccount(db: D1Database, userId: string): Promise<{ r2Keys: string[] }> {
  // 1. Collect R2 keys before the rows go (best-effort; absent tables → no keys).
  const r2Keys: string[] = [];
  try {
    const sets = await db.prepare("SELECT id FROM sets WHERE host_id = ?").bind(userId).all<{ id: string }>();
    for (const s of sets.results ?? []) r2Keys.push(`sets/${s.id}.json`);
  } catch {
    /* no sets table */
  }
  try {
    const samples = await db.prepare("SELECT r2_key FROM user_samples WHERE user_id = ?").bind(userId).all<{ r2_key: string }>();
    for (const s of samples.results ?? []) if (s.r2_key) r2Keys.push(s.r2_key);
  } catch {
    /* no samples table */
  }

  // 2. Clear every per-user row. Order is irrelevant (no enforced FKs); core tables first.
  await tryRun(db, "DELETE FROM connections WHERE user_id = ?", userId);
  await tryRun(db, "DELETE FROM sessions WHERE user_id = ?", userId);
  await tryRun(db, "DELETE FROM sync_log WHERE pair_id IN (SELECT id FROM sync_pairs WHERE user_id = ?)", userId);
  await tryRun(db, "DELETE FROM sync_pairs WHERE user_id = ?", userId);
  await tryRun(db, "DELETE FROM user_settings WHERE user_id = ?", userId);
  await tryRun(db, "DELETE FROM user_library WHERE user_id = ?", userId);
  await tryRun(db, "DELETE FROM user_track_stats WHERE user_id = ?", userId);
  await tryRun(db, "DELETE FROM user_samples WHERE user_id = ?", userId);
  await tryRun(db, "DELETE FROM user_cookies WHERE user_id = ?", userId); // legacy 0006, unused but keyed
  // Social graph — both directions (the user as actor and as target).
  await tryRun(db, "DELETE FROM follows WHERE follower_id = ? OR followee_id = ?", userId, userId);
  await tryRun(db, "DELETE FROM blocks WHERE blocker_id = ? OR blocked_id = ?", userId, userId);
  // Live directory + recorded sets (R2 blobs purged by the caller via r2Keys).
  await tryRun(db, "DELETE FROM rooms WHERE host_id = ?", userId);
  await tryRun(db, "DELETE FROM sets WHERE host_id = ?", userId);
  // Reports the user FILED (privacy). Reports ABOUT them are moderation history → kept.
  await tryRun(db, "DELETE FROM reports WHERE reporter = ?", userId);
  // Notifications: their own feed + read cursor, AND any event where THEY are the actor (else the
  // deleted user lingers as a ghost actor in other people's bells). Presence + pending jam grants.
  await tryRun(db, "DELETE FROM notifications WHERE user_id = ? OR actor_id = ?", userId, userId);
  await tryRun(db, "DELETE FROM notif_seen WHERE user_id = ?", userId);
  await tryRun(db, "DELETE FROM presence WHERE user_id = ?", userId);
  await tryRun(db, "DELETE FROM session_invites WHERE host_id = ? OR guest_id = ?", userId, userId);
  // Shared contributions: keep the content, drop the attribution.
  await tryRun(db, "UPDATE lyrics SET contributor = NULL WHERE contributor = ?", userId);

  // 3. Finally the account itself (this frees the @handle for immediate reuse).
  await db.prepare("DELETE FROM users WHERE id = ?").bind(userId).run();
  return { r2Keys };
}
