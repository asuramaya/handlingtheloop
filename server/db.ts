// D1 data layer for the SaaS account/sync features. A thin, typed wrapper — no
// ORM. Service tokens are encrypted (crypto.ts) before they touch a column.
import { decrypt, encrypt } from "./crypto";
import { HANDLE_RENAME_COOLDOWN_MS } from "./security";

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

// ── Public identity: handles + user-owned profile (migration 0012) ───────────

let identityReady = false;
const IDENTITY_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ["handle", "TEXT"],
  ["handle_folded", "TEXT"],
  ["display_name", "TEXT"],
  ["avatar_url", "TEXT"],
  ["bio", "TEXT"],
  ["handle_set_at", "INTEGER"],
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
  identityReady = true;
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
  try {
    await db
      .prepare("UPDATE users SET handle=?, handle_folded=?, handle_set_at=? WHERE id=?")
      .bind(handle, folded, now(), userId)
      .run();
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
  f: { display_name?: string | null; bio?: string | null; avatar_url?: string | null },
): Promise<void> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (f.display_name !== undefined) (sets.push("display_name=?"), vals.push(f.display_name));
  if (f.bio !== undefined) (sets.push("bio=?"), vals.push(f.bio));
  if (f.avatar_url !== undefined) (sets.push("avatar_url=?"), vals.push(f.avatar_url));
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

// ── Social graph: follows + blocks (migration 0013) ──────────────────────────

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

// ── Room registry: live public-room directory shadow (migration 0014) ────────

let roomsReady = false;
export async function ensureRoomsTable(db: D1Database): Promise<void> {
  if (roomsReady) return;
  await db
    .prepare(
      "CREATE TABLE IF NOT EXISTS rooms (host_id TEXT PRIMARY KEY, title TEXT, genre TEXT, live INTEGER NOT NULL DEFAULT 0, listeners INTEGER NOT NULL DEFAULT 0, np_title TEXT, np_artist TEXT, np_video TEXT, started_at INTEGER, last_seen INTEGER NOT NULL)",
    )
    .run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_rooms_live ON rooms(live, last_seen)").run();
  roomsReady = true;
}

export interface RoomAnnounce {
  title?: string | null;
  genre?: string | null;
  listeners?: number;
  npTitle?: string | null;
  npArtist?: string | null;
  npVideo?: string | null;
}

/** Upsert the host's room as LIVE + bump the heartbeat. `started_at` is set only when a
 *  room transitions dark→live, so it reads the broadcast's true start across heartbeats. */
export async function announceRoom(db: D1Database, hostId: string, a: RoomAnnounce): Promise<void> {
  const t = now();
  await db
    .prepare(
      `INSERT INTO rooms (host_id, title, genre, live, listeners, np_title, np_artist, np_video, started_at, last_seen)
       VALUES (?,?,?,1,?,?,?,?,?,?)
       ON CONFLICT(host_id) DO UPDATE SET
         title=excluded.title, genre=excluded.genre, live=1, listeners=excluded.listeners,
         np_title=excluded.np_title, np_artist=excluded.np_artist, np_video=excluded.np_video,
         started_at=COALESCE(rooms.started_at, excluded.started_at), last_seen=excluded.last_seen`,
    )
    .bind(hostId, a.title ?? null, a.genre ?? null, a.listeners ?? 0, a.npTitle ?? null, a.npArtist ?? null, a.npVideo ?? null, t, t)
    .run();
}

/** Mark the host's room dark (host stopped broadcasting). */
export async function closeRoom(db: D1Database, hostId: string): Promise<void> {
  await db.prepare("UPDATE rooms SET live=0, started_at=NULL WHERE host_id=?").bind(hostId).run();
}

/** Is a specific host broadcasting right now (live + heartbeating within freshMs)? For the
 *  /@handle profile's "Listen live" affordance. */
export async function liveRoomStatus(
  db: D1Database,
  hostId: string,
  freshMs = 90_000,
): Promise<{ live: boolean; listeners: number }> {
  const r = await db
    .prepare("SELECT live, listeners, last_seen FROM rooms WHERE host_id=?")
    .bind(hostId)
    .first<{ live: number; listeners: number; last_seen: number }>();
  const live = !!r && r.live === 1 && now() - r.last_seen < freshMs;
  return { live, listeners: live ? r!.listeners : 0 };
}

export interface LiveRoom {
  handle: string;
  displayName: string | null;
  avatar: string | null;
  title: string | null;
  genre: string | null;
  listeners: number;
  npTitle: string | null;
  npArtist: string | null;
  startedAt: number | null;
}

/** The live public-room directory: rooms broadcasting + heartbeating within `freshMs`,
 *  busiest first. Stale rooms (host vanished) age out by the freshness filter (E11). */
export async function liveRooms(db: D1Database, limit = 100, freshMs = 90_000): Promise<LiveRoom[]> {
  const cutoff = now() - freshMs;
  const r = await db
    .prepare(
      `SELECT u.handle, u.display_name AS displayName, COALESCE(u.avatar_url, u.avatar) AS avatar,
              r.title, r.genre, r.listeners, r.np_title AS npTitle, r.np_artist AS npArtist, r.started_at AS startedAt
       FROM rooms r JOIN users u ON u.id = r.host_id
       WHERE r.live = 1 AND r.last_seen > ? AND u.handle IS NOT NULL
       ORDER BY r.listeners DESC, r.started_at DESC LIMIT ?`,
    )
    .bind(cutoff, limit)
    .all<LiveRoom>();
  return r.results ?? [];
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

// ---- community-pooled lyric transcripts (Whisper-on-vocal-stem; migration 0009) ------
// The PRIMARY lyrics source: one desktop GPU decodes a track's vocal stem and contributes
// here, so every later device + repeat play gets accurate, track-timed lyrics for free.
// The `captions` table above is the fallback. Best transcript on file wins (prefer the
// larger `small` model, else newest).
export interface LyricsRow {
  model: string;
  lang: string;
  conf: number;
  lines: { start: number; end: number; text: string; words?: { t: number; w: string; d?: number }[] }[];
}
export async function getLyrics(db: D1Database, videoId: string): Promise<LyricsRow | null> {
  const row = await db
    .prepare("SELECT model, lang, conf, lines FROM lyrics WHERE video_id = ? ORDER BY (model = 'small') DESC, created_at DESC LIMIT 1")
    .bind(videoId)
    .first<{ model: string; lang: string; conf: number; lines: string }>();
  if (!row?.lines) return null;
  try {
    const lines = JSON.parse(row.lines);
    return Array.isArray(lines) ? { model: row.model, lang: row.lang, conf: row.conf, lines } : null;
  } catch {
    return null;
  }
}
export async function putLyrics(
  db: D1Database,
  v: { videoId: string; model: string; lang: string; conf: number; lines: unknown; contributor?: string | null },
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO lyrics (video_id, model, lang, conf, lines, contributor, created_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(video_id, model) DO UPDATE SET lang = excluded.lang, conf = excluded.conf, lines = excluded.lines, contributor = excluded.contributor, created_at = excluded.created_at",
    )
    .bind(v.videoId, v.model, v.lang, v.conf, JSON.stringify(v.lines), v.contributor ?? null, now())
    .run();
}
// Takedown lever — drop every pooled transcript for a video (all models).
export async function deleteLyrics(db: D1Database, videoId: string): Promise<void> {
  await db.prepare("DELETE FROM lyrics WHERE video_id = ?").bind(videoId).run();
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

/** Fetch known analysis (BPM/key) for a batch of videoIds — lets the auto-mixer
 *  score/transition candidates it hasn't decoded, using the crowdsourced dataset. */
export async function getAnalysisByIds(db: D1Database, ids: string[]): Promise<TrackAnalysisRow[]> {
  const clean = Array.from(new Set(ids.filter((id) => /^[\w-]{11}$/.test(id)))).slice(0, 100);
  if (!clean.length) return [];
  const ph = clean.map(() => "?").join(",");
  const r = await db
    .prepare(`SELECT video_id, bpm, music_key, key_name, beat_offset, duration FROM track_analysis WHERE video_id IN (${ph})`)
    .bind(...clean)
    .all<TrackAnalysisRow>();
  return r.results ?? [];
}

// --- Acoustic identity (the global AcoustID cache) --------------------------

export interface TrackIdentityRow {
  video_id: string;
  isrc: string | null;
  mbid: string | null;
  artist: string | null;
  title: string | null;
  source: string | null;
}

/** The cached identity for a video (null if never looked up). */
export async function getIdentity(db: D1Database, videoId: string): Promise<TrackIdentityRow | null> {
  return db
    .prepare("SELECT video_id, isrc, mbid, artist, title, source FROM track_identity WHERE video_id = ?")
    .bind(videoId)
    .first<TrackIdentityRow>();
}

/** Cached identities for a batch of videoIds (auto-mix candidate ISRCs). */
export async function getIdentitiesByIds(db: D1Database, ids: string[]): Promise<TrackIdentityRow[]> {
  const clean = Array.from(new Set(ids.filter((id) => /^[\w-]{11}$/.test(id)))).slice(0, 100);
  if (!clean.length) return [];
  const ph = clean.map(() => "?").join(",");
  const r = await db
    .prepare(`SELECT video_id, isrc, mbid, artist, title, source FROM track_identity WHERE video_id IN (${ph})`)
    .bind(...clean)
    .all<TrackIdentityRow>();
  return r.results ?? [];
}

/** Record an identification (or a "no match", with nulls) so we never re-query it. */
export async function upsertIdentity(
  db: D1Database,
  v: { videoId: string; isrc?: string | null; mbid?: string | null; artist?: string | null; title?: string | null; source: string },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO track_identity (video_id, isrc, mbid, artist, title, source, updated_at)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(video_id) DO UPDATE SET
         isrc=excluded.isrc, mbid=excluded.mbid, artist=excluded.artist,
         title=excluded.title, source=excluded.source, updated_at=excluded.updated_at`,
    )
    .bind(v.videoId, v.isrc ?? null, v.mbid ?? null, v.artist ?? null, v.title ?? null, v.source, now())
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
  // Conditional upsert: only write when the incoming value is BOTH newer (last-write-wins) AND
  // actually different. A stale or identical PUT (a cross-device adopt re-pushing the same blob)
  // no-ops at the DB — 0 rows written, no separate read needed.
  await db
    .prepare(
      `INSERT INTO user_settings (user_id, data, updated_at) VALUES (?,?,?)
       ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
         WHERE excluded.updated_at > user_settings.updated_at AND excluded.data <> user_settings.data`,
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

let ensuredInvites = false;
async function ensureRoomInvites(db: D1Database): Promise<void> {
  if (ensuredInvites) return; // once per isolate — the CREATE was running on every invite mint / guest join
  await db
    .prepare("CREATE TABLE IF NOT EXISTS room_invites (code TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER NOT NULL)")
    .run();
  ensuredInvites = true;
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

// --- Per-user play stats (the profile's "top songs") ---------------------------
// An aggregate, not a log: one row per (user, track) with a running count, so "top N"
// is an indexed query and the table can't grow without bound. See migration 0008 — also
// ensured here so it works before the migration is applied to an existing DB.
let ensuredPlays = false;
async function ensureUserPlays(db: D1Database): Promise<void> {
  if (ensuredPlays) return;
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS user_track_stats (
         user_id TEXT NOT NULL, video_id TEXT NOT NULL,
         title TEXT, artist TEXT, thumbnail TEXT,
         plays INTEGER NOT NULL DEFAULT 0, last_played_at INTEGER NOT NULL,
         PRIMARY KEY (user_id, video_id))`,
    )
    .run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_user_track_plays ON user_track_stats(user_id, plays DESC)").run();
  ensuredPlays = true;
}

export interface TopTrack {
  videoId: string;
  title: string;
  artist: string;
  thumbnail: string | null;
  plays: number;
}

/** Record one play of a track by a user (increments the running count, refreshes meta). */
export async function logUserPlay(
  db: D1Database,
  userId: string,
  t: { videoId: string; title?: string; artist?: string; thumbnail?: string | null },
): Promise<void> {
  await ensureUserPlays(db);
  await db
    .prepare(
      `INSERT INTO user_track_stats (user_id, video_id, title, artist, thumbnail, plays, last_played_at)
       VALUES (?,?,?,?,?,1,?)
       ON CONFLICT(user_id, video_id) DO UPDATE SET
         plays = plays + 1,
         last_played_at = excluded.last_played_at,
         title = COALESCE(excluded.title, title),
         artist = COALESCE(excluded.artist, artist),
         thumbnail = COALESCE(excluded.thumbnail, thumbnail)`,
    )
    .bind(userId, t.videoId, t.title ?? null, t.artist ?? null, t.thumbnail ?? null, now())
    .run();
}

/** A user's most-played tracks, highest first (the profile's top songs). */
export async function getTopTracks(db: D1Database, userId: string, limit = 12): Promise<TopTrack[]> {
  await ensureUserPlays(db);
  const r = await db
    .prepare(
      `SELECT video_id, title, artist, thumbnail, plays
       FROM user_track_stats WHERE user_id = ?
       ORDER BY plays DESC, last_played_at DESC LIMIT ?`,
    )
    .bind(userId, Math.min(Math.max(limit, 1), 50))
    .all<{ video_id: string; title: string | null; artist: string | null; thumbnail: string | null; plays: number }>();
  return (r.results ?? []).map((row) => ({
    videoId: row.video_id,
    title: row.title || "",
    artist: row.artist || "",
    thumbnail: row.thumbnail,
    plays: row.plays,
  }));
}
