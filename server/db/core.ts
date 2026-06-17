// D1 data layer — shared core. The minimal typed D1 surface, the user/session/token
// types every domain module leans on, and find-or-create + session helpers.
// A thin, typed wrapper — no ORM.

// Minimal D1 surface (avoids a hard dep on @cloudflare/workers-types).
export interface D1Result<T = unknown> {
  results?: T[];
  success: boolean;
}
export interface D1PreparedStatement {
  bind(...vals: unknown[]): D1PreparedStatement;
  first<T = unknown>(col?: string): Promise<T | null>;
  all<T = unknown>(): Promise<D1Result<T>>;
  run(): Promise<D1Result>;
}
export interface D1Database {
  prepare(query: string): D1PreparedStatement;
}

export const now = () => Date.now();
export const uuid = () => crypto.randomUUID();

export type Provider = "google" | "spotify" | "tidal";

export interface User {
  id: string;
  google_sub: string | null;
  email: string | null;
  name: string | null; // Google-mirrored display name — PRIVATE seed, refreshed every login. Never user-editable.
  avatar: string | null; // Google-mirrored avatar — PRIVATE seed. Public surfaces prefer avatar_url ?? avatar.
  created_at: number | null; // epoch ms the account was created — "member since" on the profile
  // Social identity (migration 0012). Optional so pre-handle code paths still build.
  handle?: string | null; // public @handle, case-preserved; NULL until claimed
  display_name?: string | null; // user-owned public name — overrides `name`
  avatar_url?: string | null; // user-owned public avatar — overrides `avatar`
  bio?: string | null; // user-owned public bio
}

export interface GoogleProfile {
  sub: string;
  email?: string;
  name?: string;
  picture?: string;
}

export interface TokenSet {
  access_token: string;
  refresh_token?: string;
  expires_at?: number; // epoch ms
  scope?: string;
  provider_user_id?: string;
}

/** Find-or-create a user by their Google identity; refresh profile + last_login.
 *  IMPORTANT: this writes ONLY the Google-mirror fields (email/name/avatar) +
 *  last_login. It must NEVER touch the user-owned identity (handle / display_name /
 *  avatar_url / bio) — that is the whole point of the 0012 column split, and the
 *  reason a re-login can no longer stomp a user's chosen public identity. */
export async function upsertGoogleUser(db: D1Database, p: GoogleProfile): Promise<User> {
  const existing = await db
    .prepare(
      "SELECT id, google_sub, email, name, avatar, created_at, handle, display_name, avatar_url, bio FROM users WHERE google_sub = ?",
    )
    .bind(p.sub)
    .first<User>();
  if (existing) {
    await db
      .prepare("UPDATE users SET email=?, name=?, avatar=?, last_login=? WHERE id=?")
      .bind(p.email ?? null, p.name ?? null, p.picture ?? null, now(), existing.id)
      .run();
    return { ...existing, email: p.email ?? null, name: p.name ?? null, avatar: p.picture ?? null };
  }
  const id = uuid();
  const createdAt = now();
  await db
    .prepare("INSERT INTO users (id, google_sub, email, name, avatar, created_at, last_login) VALUES (?,?,?,?,?,?,?)")
    .bind(id, p.sub, p.email ?? null, p.name ?? null, p.picture ?? null, createdAt, createdAt)
    .run();
  return { id, google_sub: p.sub, email: p.email ?? null, name: p.name ?? null, avatar: p.picture ?? null, created_at: createdAt };
}

export async function createSession(db: D1Database, userId: string, sessionId: string, ttlMs: number): Promise<void> {
  await db
    .prepare("INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?,?,?,?)")
    .bind(sessionId, userId, now(), now() + ttlMs)
    .run();
}

export async function userBySession(db: D1Database, sessionId: string): Promise<User | null> {
  const row = await db
    .prepare(
      `SELECT u.id, u.google_sub, u.email, u.name, u.avatar, u.created_at,
              u.handle, u.display_name, u.avatar_url, u.bio
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id = ? AND s.expires_at > ?`,
    )
    .bind(sessionId, now())
    .first<User>();
  return row ?? null;
}

export async function deleteSession(db: D1Database, sessionId: string): Promise<void> {
  await db.prepare("DELETE FROM sessions WHERE id = ?").bind(sessionId).run();
}
