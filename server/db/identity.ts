// Public identity: handles + user-owned profile (migration 0012).
import { HANDLE_RENAME_COOLDOWN_MS, foldHandle } from "../security";
import { type D1Database, type User, now } from "./core";

let identityReady = false;
const IDENTITY_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ["handle", "TEXT"],
  ["handle_folded", "TEXT"],
  ["display_name", "TEXT"],
  ["avatar_url", "TEXT"],
  ["bio", "TEXT"],
  ["handle_set_at", "INTEGER"],
  // 0021 — privacy + moderation
  ["private", "INTEGER NOT NULL DEFAULT 0"],
  ["hide_presence", "INTEGER NOT NULL DEFAULT 0"],
  ["status", "TEXT NOT NULL DEFAULT 'active'"],
];

/** Add the 0012 identity columns + unique index to an older/local DB that predates
 *  the migration (mirrors the migrations/0012 file). Idempotent — a re-ADD throws
 *  "duplicate column", which we swallow. Runs at most once per worker instance. */
export async function ensureIdentityColumns(db: D1Database): Promise<void> {
  if (identityReady) return;
  for (const [col, type] of IDENTITY_COLUMNS) {
    try {
      await db.prepare(`ALTER TABLE users ADD COLUMN ${col} ${type}`).run();
    } catch {
      /* column already exists */
    }
  }
  try {
    await db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_handle_folded ON users(handle_folded)").run();
  } catch {
    /* index already exists */
  }
  try {
    await db
      .prepare("CREATE TABLE IF NOT EXISTS reserved_handles (folded TEXT PRIMARY KEY, until INTEGER NOT NULL, prev_user TEXT)")
      .run();
  } catch {
    /* table already exists */
  }
  identityReady = true;
}

// How long a freed/renamed @handle is held before anyone else can claim it (anti-impersonation).
export const RESERVED_HANDLE_HOLD_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** Tombstone a freed handle: hold `folded` for the window; `prevUser` may re-claim during it. */
export async function reserveHandle(db: D1Database, folded: string, prevUser: string): Promise<void> {
  if (!folded) return;
  await db
    .prepare("INSERT OR REPLACE INTO reserved_handles (folded, until, prev_user) VALUES (?,?,?)")
    .bind(folded, now() + RESERVED_HANDLE_HOLD_MS, prevUser)
    .run();
}

/** Is `folded` under a live reservation by someone OTHER than `exceptUser`? (Expired holds and
 *  the prev-owner's own re-claim return false.) */
export async function isHandleReserved(db: D1Database, folded: string, exceptUser: string): Promise<boolean> {
  const r = await db
    .prepare("SELECT prev_user FROM reserved_handles WHERE folded=? AND until > ?")
    .bind(folded, now())
    .first<{ prev_user: string | null }>();
  return !!r && r.prev_user !== exceptUser;
}

/** True if any OTHER user already holds this folded handle. The DB UNIQUE index is
 *  the real guard against races; this is for a friendly pre-check message. */
export async function handleTaken(db: D1Database, folded: string, exceptUserId?: string): Promise<boolean> {
  const sql = exceptUserId
    ? "SELECT id FROM users WHERE handle_folded = ? AND id <> ?"
    : "SELECT id FROM users WHERE handle_folded = ?";
  const stmt = exceptUserId ? db.prepare(sql).bind(folded, exceptUserId) : db.prepare(sql).bind(folded);
  return !!(await stmt.first());
}

export type ClaimResult = { ok: true; handle: string } | { ok: false; reason: string };

/** Claim or rename a user's handle. `handle`/`folded` must already be validated
 *  (server/security.ts validateHandle). Uniqueness is enforced by the DB index:
 *  a conflict — whether caught by the pre-check or by the failing UPDATE — returns
 *  ok:false "taken", the atomic, TOCTOU-free signal. */
export async function setUserHandle(
  db: D1Database,
  userId: string,
  handle: string,
  folded: string,
): Promise<ClaimResult> {
  // Rename cooldown (first claim is free — only an existing handle is rate-limited).
  const cur = await db
    .prepare("SELECT handle, handle_set_at FROM users WHERE id=?")
    .bind(userId)
    .first<{ handle: string | null; handle_set_at: number | null }>();
  if (cur?.handle && cur.handle_set_at) {
    const remaining = HANDLE_RENAME_COOLDOWN_MS - (now() - cur.handle_set_at);
    if (remaining > 0) {
      const days = Math.ceil(remaining / 86_400_000);
      return { ok: false, reason: `you can change your handle again in ${days} day${days === 1 ? "" : "s"}` };
    }
  }
  if (await handleTaken(db, folded, userId)) return { ok: false, reason: "taken" };
  if (await isHandleReserved(db, folded, userId)) return { ok: false, reason: "reserved" };
  try {
    await db
      .prepare("UPDATE users SET handle=?, handle_folded=?, handle_set_at=? WHERE id=?")
      .bind(handle, folded, now(), userId)
      .run();
    // Tombstone the handle they just left (a real rename) so it can't be re-claimed for impersonation;
    // and clear any reservation on the one they just took (reclaiming your own held handle).
    if (cur?.handle && foldHandle(cur.handle) !== folded) await reserveHandle(db, foldHandle(cur.handle), userId);
    await db.prepare("DELETE FROM reserved_handles WHERE folded=?").bind(folded).run();
    return { ok: true, handle };
  } catch {
    return { ok: false, reason: "taken" }; // lost the race to the UNIQUE index
  }
}

/** Update the user-owned public profile fields. Undefined fields are left as-is;
 *  pass null to clear one. Never touches the Google-mirror name/avatar. */
export async function updateProfile(
  db: D1Database,
  userId: string,
  f: { display_name?: string | null; bio?: string | null; avatar_url?: string | null; private?: number; hide_presence?: number },
): Promise<void> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (f.display_name !== undefined) (sets.push("display_name=?"), vals.push(f.display_name));
  if (f.bio !== undefined) (sets.push("bio=?"), vals.push(f.bio));
  if (f.avatar_url !== undefined) (sets.push("avatar_url=?"), vals.push(f.avatar_url));
  if (f.private !== undefined) (sets.push("private=?"), vals.push(f.private));
  if (f.hide_presence !== undefined) (sets.push("hide_presence=?"), vals.push(f.hide_presence));
  if (!sets.length) return;
  vals.push(userId);
  await db.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id=?`).bind(...vals).run();
}

/** Look up a user by the folded form of their handle (for the public /@handle profile). */
export async function userByHandle(db: D1Database, folded: string): Promise<User | null> {
  const row = await db
    .prepare(
      "SELECT id, google_sub, email, name, avatar, created_at, handle, display_name, avatar_url, bio FROM users WHERE handle_folded = ?",
    )
    .bind(folded)
    .first<User>();
  return row ?? null;
}
