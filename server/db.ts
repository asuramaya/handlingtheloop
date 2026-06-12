// D1 data layer for the SaaS account/sync features. A thin, typed wrapper — no
// ORM. Service tokens are encrypted (crypto.ts) before they touch a column.
import { decrypt, encrypt } from "./crypto";

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

const now = () => Date.now();
const uuid = () => crypto.randomUUID();

export type Provider = "google" | "spotify";

export interface User {
  id: string;
  google_sub: string | null;
  email: string | null;
  name: string | null;
  avatar: string | null;
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

/** Find-or-create a user by their Google identity; refresh profile + last_login. */
export async function upsertGoogleUser(db: D1Database, p: GoogleProfile): Promise<User> {
  const existing = await db
    .prepare("SELECT id, google_sub, email, name, avatar FROM users WHERE google_sub = ?")
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
  await db
    .prepare("INSERT INTO users (id, google_sub, email, name, avatar, created_at, last_login) VALUES (?,?,?,?,?,?,?)")
    .bind(id, p.sub, p.email ?? null, p.name ?? null, p.picture ?? null, now(), now())
    .run();
  return { id, google_sub: p.sub, email: p.email ?? null, name: p.name ?? null, avatar: p.picture ?? null };
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
      `SELECT u.id, u.google_sub, u.email, u.name, u.avatar
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

/** Which services a user has linked (for the UI). */
export async function listConnections(db: D1Database, userId: string): Promise<Provider[]> {
  const r = await db
    .prepare("SELECT provider FROM connections WHERE user_id = ?")
    .bind(userId)
    .all<{ provider: Provider }>();
  return (r.results ?? []).map((x) => x.provider);
}

/** Upsert a service connection, encrypting tokens at rest. */
export async function saveConnection(
  db: D1Database,
  userId: string,
  provider: Provider,
  tokens: TokenSet,
  encKey: string,
): Promise<void> {
  const enc = await encrypt(tokens.access_token, encKey);
  const encRefresh = tokens.refresh_token ? await encrypt(tokens.refresh_token, encKey) : null;
  const id = uuid();
  // Keep an existing refresh token if this grant didn't return a new one (Google
  // only returns refresh_token on first consent).
  await db
    .prepare(
      `INSERT INTO connections
         (id, user_id, provider, provider_user_id, access_token, refresh_token, expires_at, scope, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(user_id, provider) DO UPDATE SET
         provider_user_id = COALESCE(excluded.provider_user_id, connections.provider_user_id),
         access_token     = excluded.access_token,
         refresh_token    = COALESCE(excluded.refresh_token, connections.refresh_token),
         expires_at       = excluded.expires_at,
         scope            = excluded.scope,
         updated_at       = excluded.updated_at`,
    )
    .bind(
      id,
      userId,
      provider,
      tokens.provider_user_id ?? null,
      enc,
      encRefresh,
      tokens.expires_at ?? null,
      tokens.scope ?? null,
      now(),
      now(),
    )
    .run();
}

export interface DecryptedConnection {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
  scope: string | null;
  providerUserId: string | null;
}

/** Fetch + decrypt a connection's tokens (null if the user hasn't linked it). */
export async function getConnection(
  db: D1Database,
  userId: string,
  provider: Provider,
  encKey: string,
): Promise<DecryptedConnection | null> {
  const row = await db
    .prepare(
      "SELECT access_token, refresh_token, expires_at, scope, provider_user_id FROM connections WHERE user_id=? AND provider=?",
    )
    .bind(userId, provider)
    .first<{
      access_token: string;
      refresh_token: string | null;
      expires_at: number | null;
      scope: string | null;
      provider_user_id: string | null;
    }>();
  if (!row) return null;
  return {
    accessToken: await decrypt(row.access_token, encKey),
    refreshToken: row.refresh_token ? await decrypt(row.refresh_token, encKey) : null,
    expiresAt: row.expires_at,
    scope: row.scope,
    providerUserId: row.provider_user_id,
  };
}

export async function deleteConnection(db: D1Database, userId: string, provider: Provider): Promise<void> {
  await db.prepare("DELETE FROM connections WHERE user_id=? AND provider=?").bind(userId, provider).run();
}

// --- Community index --------------------------------------------------------
// The browsable catalog of cached tracks. Decouples the community list from an
// R2 bucket scan: an indexed, ordered query instead of O(objects) per request.

export interface CommunityTrack {
  videoId: string;
  title: string;
  artist: string;
  duration: number;
  thumbnail: string | null;
}

interface CommunityRow {
  video_id: string;
  title: string;
  artist: string | null;
  duration: number;
  thumbnail: string | null;
}

/** Insert/refresh a track in the community index. Empty fields never clobber known ones. */
export async function upsertCommunityTrack(
  db: D1Database,
  t: { videoId: string; title?: string; artist?: string | null; duration?: number; thumbnail?: string | null },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO community_tracks (video_id, title, artist, duration, thumbnail, cached_at, updated_at)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(video_id) DO UPDATE SET
         title     = CASE WHEN excluded.title <> '' THEN excluded.title ELSE community_tracks.title END,
         artist    = COALESCE(NULLIF(excluded.artist, ''), community_tracks.artist),
         duration  = CASE WHEN excluded.duration > 0 THEN excluded.duration ELSE community_tracks.duration END,
         thumbnail = COALESCE(excluded.thumbnail, community_tracks.thumbnail),
         updated_at = excluded.updated_at`,
    )
    .bind(t.videoId, t.title ?? "", t.artist ?? null, t.duration ?? 0, t.thumbnail ?? null, now(), now())
    .run();
}

/** Newest-first page of the community catalog. */
export async function listCommunityTracks(db: D1Database, limit: number): Promise<CommunityTrack[]> {
  const r = await db
    .prepare("SELECT video_id, title, artist, duration, thumbnail FROM community_tracks ORDER BY cached_at DESC LIMIT ?")
    .bind(Math.max(1, Math.min(limit, 500)))
    .all<CommunityRow>();
  return (r.results ?? []).map((x) => ({
    videoId: x.video_id,
    title: x.title,
    artist: x.artist ?? "",
    duration: x.duration,
    thumbnail: x.thumbnail,
  }));
}

// --- Caption cache -------------------------------------------------------
// Persisted so a single lucky upstream pull serves captions to every later
// request (any isolate/deck/user). See migrations/0007_captions.sql.

/** Cached caption cues for a video, or null on a miss. */
export async function getCachedCaptions(
  db: D1Database,
  videoId: string,
): Promise<{ start: number; end: number; text: string }[] | null> {
  const row = await db.prepare("SELECT cues FROM captions WHERE video_id = ?").bind(videoId).first<{ cues: string }>();
  if (!row?.cues) return null;
  try {
    const cues = JSON.parse(row.cues);
    return Array.isArray(cues) ? cues : null;
  } catch {
    return null;
  }
}

/** Persist a successful caption pull. Callers must not store empty arrays. */
export async function putCachedCaptions(
  db: D1Database,
  videoId: string,
  cues: { start: number; end: number; text: string }[],
): Promise<void> {
  await db
    .prepare("INSERT INTO captions (video_id, cues, updated_at) VALUES (?,?,?) ON CONFLICT(video_id) DO UPDATE SET cues = excluded.cues, updated_at = excluded.updated_at")
    .bind(videoId, JSON.stringify(cues), now())
    .run();
}

/** Remove a track from the catalog (takedown). Bytes stay in R2 until separately purged. */
export async function deleteCommunityTrack(db: D1Database, videoId: string): Promise<void> {
  await db.prepare("DELETE FROM community_tracks WHERE video_id = ?").bind(videoId).run();
}

/** Total tracks in the community catalog. */
export async function countCommunityTracks(db: D1Database): Promise<number> {
  const r = await db.prepare("SELECT COUNT(*) AS n FROM community_tracks").first<{ n: number }>();
  return r?.n ?? 0;
}

// --- Analysis layer (the crowdsourced dataset) ------------------------------

export interface TrackAnalysisRow {
  video_id: string;
  bpm: number | null;
  music_key: string | null;
  key_name: string | null;
  beat_offset: number | null;
  duration: number | null;
}

/** Contribute/refresh a track's analysis (BPM/key/grid). Idempotent per video. */
export async function upsertAnalysis(
  db: D1Database,
  a: { videoId: string; bpm?: number | null; key?: string | null; keyName?: string | null; beatOffset?: number | null; duration?: number | null; version?: number },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO track_analysis (video_id, bpm, music_key, key_name, beat_offset, duration, version, updated_at)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(video_id) DO UPDATE SET
         bpm=excluded.bpm, music_key=excluded.music_key, key_name=excluded.key_name,
         beat_offset=excluded.beat_offset, duration=excluded.duration,
         version=excluded.version, updated_at=excluded.updated_at`,
    )
    .bind(a.videoId, a.bpm ?? null, a.key ?? null, a.keyName ?? null, a.beatOffset ?? null, a.duration ?? null, a.version ?? 1, now())
    .run();
}

/** How many tracks have analysis (for admin coverage). */
export async function countAnalysis(db: D1Database): Promise<number> {
  const r = await db.prepare("SELECT COUNT(*) AS n FROM track_analysis").first<{ n: number }>();
  return r?.n ?? 0;
}

/** Page of analysis rows (for the HF export). */
export async function listAnalysis(db: D1Database, limit = 1000, offset = 0): Promise<TrackAnalysisRow[]> {
  const r = await db
    .prepare("SELECT video_id, bpm, music_key, key_name, beat_offset, duration FROM track_analysis ORDER BY updated_at DESC LIMIT ? OFFSET ?")
    .bind(Math.max(1, Math.min(limit, 5000)), Math.max(0, offset))
    .all<TrackAnalysisRow>();
  return r.results ?? [];
}

// --- Admin: takedown audit + user control -----------------------------------

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

/** Fully remove an account: its sessions, service connections, syncs, then the user. */
export async function deleteUser(db: D1Database, userId: string): Promise<void> {
  await db.prepare("DELETE FROM connections WHERE user_id = ?").bind(userId).run();
  await db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId).run();
  await db.prepare("DELETE FROM sync_log WHERE pair_id IN (SELECT id FROM sync_pairs WHERE user_id = ?)").bind(userId).run();
  await db.prepare("DELETE FROM sync_pairs WHERE user_id = ?").bind(userId).run();
  await db.prepare("DELETE FROM users WHERE id = ?").bind(userId).run();
}

/** The signed-in user's synced UI settings blob (JSON string), or null if never saved. */
export async function getUserSettings(
  db: D1Database,
  userId: string,
): Promise<{ data: string; updated_at: number } | null> {
  return db
    .prepare("SELECT data, updated_at FROM user_settings WHERE user_id = ?")
    .bind(userId)
    .first<{ data: string; updated_at: number }>();
}

/** Upsert the user's settings blob (last-write-wins by the client-supplied timestamp). */
export async function putUserSettings(db: D1Database, userId: string, data: string, updatedAt: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO user_settings (user_id, data, updated_at) VALUES (?,?,?)
       ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
    )
    .bind(userId, data, updatedAt)
    .run();
}

// NOTE: server-side storage of the user's YouTube *streaming cookie* (the
// account-grade credential) was intentionally removed. It was wired to no route
// and storing that cookie at rest is exactly the blast radius we avoid — the
// cookie stays client-side only (memory + sessionStorage + TTL; see
// src/htl/media/auth.ts). The `user_cookies` table (migration 0006) is left in
// place but unused; drop it in a later migration if desired.

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

// --- Shared-session invites -------------------------------------------------
// An invite code is an opaque handle to a host's session. Guests open
// /?join=<code>; the Worker resolves the code to the host's user id and routes the
// WebSocket into that session's DjRoom. Codes are non-secret (the session itself is
// authed per-connection) and stable per host, so a host's link doesn't churn.

async function ensureRoomInvites(db: D1Database): Promise<void> {
  await db
    .prepare("CREATE TABLE IF NOT EXISTS room_invites (code TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER NOT NULL)")
    .run();
}

const INVITE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"; // no ambiguous chars (0/o/1/l/i)
// 12 chars over a 31-symbol alphabet ≈ 59 bits — not feasibly enumerable, so an
// anonymous guest can't brute-force their way into mirroring random sessions.
function newInviteCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let s = "";
  for (const b of bytes) s += INVITE_ALPHABET[b % INVITE_ALPHABET.length];
  return s;
}

/** The host's stable invite code (created on first ask). */
export async function getOrCreateInvite(db: D1Database, userId: string): Promise<string> {
  await ensureRoomInvites(db);
  const existing = await db.prepare("SELECT code FROM room_invites WHERE user_id = ? LIMIT 1").bind(userId).first<{ code: string }>();
  if (existing?.code) return existing.code;
  const code = newInviteCode();
  await db.prepare("INSERT INTO room_invites (code, user_id, created_at) VALUES (?,?,?)").bind(code, userId, now()).run();
  return code;
}

/** Resolve an invite code to the host user id it points at (null if unknown). */
export async function inviteOwner(db: D1Database, code: string): Promise<string | null> {
  await ensureRoomInvites(db);
  const row = await db.prepare("SELECT user_id FROM room_invites WHERE code = ?").bind(code.slice(0, 16)).first<{ user_id: string }>();
  return row?.user_id ?? null;
}
