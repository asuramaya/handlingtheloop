// Room registry: live public-room directory shadow (migration 0014) + shared-session
// invite codes.
import { type D1Database, now } from "./core";

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
 *  /@handle profile's "Listen live" affordance + the share-link OG card. Carries the now-playing
 *  fields so a crawler can render "🔴 @X is live — <track>" from this single read. */
export async function liveRoomStatus(
  db: D1Database,
  hostId: string,
  freshMs = 90_000,
): Promise<{ live: boolean; listeners: number; npTitle: string | null; npArtist: string | null }> {
  const r = await db
    .prepare("SELECT live, listeners, last_seen, np_title, np_artist FROM rooms WHERE host_id=?")
    .bind(hostId)
    .first<{ live: number; listeners: number; last_seen: number; np_title: string | null; np_artist: string | null }>();
  const live = !!r && r.live === 1 && now() - r.last_seen < freshMs;
  return {
    live,
    listeners: live ? r!.listeners : 0,
    npTitle: live ? r!.np_title : null,
    npArtist: live ? r!.np_artist : null,
  };
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
      `SELECT u.handle, u.display_name AS displayName, u.avatar_url AS avatar,
              r.title, r.genre, r.listeners, r.np_title AS npTitle, r.np_artist AS npArtist, r.started_at AS startedAt
       FROM rooms r JOIN users u ON u.id = r.host_id
       WHERE r.live = 1 AND r.last_seen > ? AND u.handle IS NOT NULL
       ORDER BY r.listeners DESC, r.started_at DESC LIMIT ?`,
    )
    .bind(cutoff, limit)
    .all<LiveRoom>();
  return r.results ?? [];
}

/** The notifications "Live now" source: rooms that the VIEWER follows that are broadcasting
 *  + fresh, newest-live first. Fan-out-on-read — a celebrity going live costs one room row,
 *  readers pay O(following ∩ live). Blocks-gated both directions (defense-in-depth: a block
 *  already deletes the follow edge, but enforce at read so the bell can never leak a blocker's
 *  live status). `startedAt` drives the client's "new since I last looked" badge. */
export async function liveFollowedRooms(db: D1Database, viewerId: string, freshMs = 90_000): Promise<LiveRoom[]> {
  const cutoff = now() - freshMs;
  const r = await db
    .prepare(
      `SELECT u.handle, u.display_name AS displayName, u.avatar_url AS avatar,
              r.title, r.genre, r.listeners, r.np_title AS npTitle, r.np_artist AS npArtist, r.started_at AS startedAt
       FROM follows f
       JOIN rooms r ON r.host_id = f.followee_id
       JOIN users u ON u.id = r.host_id
       WHERE f.follower_id = ? AND r.live = 1 AND r.last_seen > ? AND u.handle IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM blocks b
           WHERE (b.blocker_id = f.follower_id AND b.blocked_id = f.followee_id)
              OR (b.blocker_id = f.followee_id AND b.blocked_id = f.follower_id))
       ORDER BY r.started_at DESC LIMIT 50`,
    )
    .bind(viewerId, cutoff)
    .all<LiveRoom>();
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
