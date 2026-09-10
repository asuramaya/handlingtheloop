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
  /** VIEWER-RELATIVE, resolved server-side. 1 = the viewer follows this host; 2 = they follow
   *  each other. Absent for a signed-out viewer, who has no relationships to report. */
  rel?: 0 | 1 | 2;
}

/** The live public-room directory: rooms broadcasting + heartbeating within `freshMs`.
 *  Stale rooms (host vanished) age out by the freshness filter (E11).
 *
 *  ★ THE RELATIONSHIP IS RESOLVED HERE, NOT ON THE CLIENT. Discover used to fetch the viewer's
 *  ENTIRE following list and intersect it with the room list in the browser — and it fetched
 *  ONE PAGE of it, which is 50. Past 50 follows, a room hosted by someone you follow but who
 *  happened to sit on page 2 was silently filed under strangers: the personalisation degraded
 *  as the user's graph grew, quietly, with no error. Two LEFT JOINs on a table already keyed
 *  (follower_id, followee_id) answer it exactly, for any graph size, in the query that was
 *  already running.
 *
 *  `rel` is 2 for a MUTUAL follow (a "friend" — the co-play relationship the UI ranks highest),
 *  1 for one-way, 0 for a stranger. Ordering puts relationship first and listeners second:
 *  busiest-first alone is a popularity ratchet, where the rooms at the top get the taps that
 *  keep them at the top and nobody else is ever reachable. */
/** How the directory is ordered. The two are NOT interchangeable, and the difference is the
 *  whole reason only one of them can page — see liveRooms. */
export type RoomSort = "busy" | "recent";

/** The live directory page: the rows, whether this is a SLICE, and how to ask for the next one. */
export interface LiveRoomsPage {
  rooms: LiveRoom[];
  /** More rows matched than were returned. The client must not present this as the whole set. */
  truncated: boolean;
  /** The cap actually applied, so a client can say "first N" without hardcoding it. */
  limit: number;
  /** Opaque; pass back as `cursor` for the next page. Null when there is no next page, and ALWAYS
   *  null under "busy" — that ordering cannot be paged, which is a property of the data and not an
   *  omission. Deliberately opaque so the client never learns host_id: the cursor is built from it
   *  server-side and the row type does not carry it. */
  nextCursor: string | null;
}

export interface LiveRoomsOpts {
  limit?: number;
  freshMs?: number;
  viewerId?: string | null;
  sort?: RoomSort;
  /** Only meaningful with sort="recent"; ignored otherwise. */
  cursor?: string | null;
}

/** ★ TWO ORDERINGS, AND ONLY ONE OF THEM CAN HAVE A CURSOR. Operator ruling 39dc683e: "let the
 *  user pick between busy vs recent default to busy."
 *
 *  BUSY sorts by `listeners`, which announceRoom REWRITES on every heartbeat. Keyset paging over a
 *  value that moves under the reader is incoherent — a room whose count rises between page 1 and
 *  page 2 is served twice or skipped, and neither shows up as an error. So busy is capped, honest
 *  about being capped (`truncated`), and never pages: nextCursor is always null.
 *
 *  RECENT sorts by (started_at, host_id). started_at is COALESCE-preserved across heartbeats for
 *  the life of a broadcast and only cleared by closeRoom; host_id is the rooms table's primary key.
 *  So the pair is IMMUTABLE while a row is in the set and TOTAL — exactly what a keyset cursor
 *  needs, and it pages exactly.
 *
 *  ONE HONEST GAP, stated rather than hidden: a room that goes dark and re-announces gets a fresh
 *  started_at and can therefore cross a page boundary mid-walk. No cursor can prevent that — it is
 *  a row leaving the set and re-entering it, which is what "live directory" means.
 *
 *  ★ AND `rel` LEADS ONLY IN BUSY. The relationship-first ordering is a ranking, and ranking is
 *  what busy is for. Putting it in front of recent would both contradict the name and put a
 *  viewer-relative, mutable value at the head of the cursor key. Recent still RETURNS rel so the
 *  UI can badge a followed host; it just does not sort by it.
 *
 *  Truncation is detected by asking for limit+1 and returning limit — one extra row instead of a
 *  COUNT(*), which matters because this whole thread is about D1 load. */
export async function liveRooms(db: D1Database, opts: LiveRoomsOpts = {}): Promise<LiveRoomsPage> {
  const limit = opts.limit ?? 100;
  const sort: RoomSort = opts.sort === "recent" ? "recent" : "busy";
  const viewerId = opts.viewerId ?? null;
  const cutoff = now() - (opts.freshMs ?? 90_000);
  const probe = limit + 1; // +1 probe row: present ⇒ there is more behind the cap.

  const cols = `u.handle, u.display_name AS displayName, u.avatar_url AS avatar,
                r.title, r.genre, r.listeners, r.np_title AS npTitle, r.np_artist AS npArtist,
                r.started_at AS startedAt, r.host_id AS hostId`;
  const relCol = viewerId
    ? `, (CASE WHEN f.followee_id IS NULL THEN 0 WHEN b.follower_id IS NULL THEN 1 ELSE 2 END) AS rel`
    : "";
  const relJoin = viewerId
    ? `LEFT JOIN follows f ON f.follower_id = ? AND f.followee_id = r.host_id
       LEFT JOIN follows b ON b.follower_id = r.host_id AND b.followee_id = ?`
    : "";

  // Every ORDER BY here ends in host_id, the primary key. A non-total ordering paired with LIMIT
  // resolves its own boundary arbitrarily — which of two tied rows survives can differ between two
  // identical calls, a coin flip dressed as a deterministic read.
  const order =
    sort === "recent"
      ? `ORDER BY r.started_at DESC, r.host_id DESC`
      : `ORDER BY ${viewerId ? "rel DESC, " : ""}r.listeners DESC, r.started_at DESC, r.host_id DESC`;

  // ★ BLOCKS APPLY HERE TOO (operator, 2026-09-10). This directory was the ONLY viewer-relative
  // read in the codebase that ignored them — social.ts gates on blocks in eleven places,
  // presence.ts in three, and the bell's own liveFollowedRooms in one. A blocked host's live room
  // showing up in Discover while being filtered from every other surface is not a policy, it is a
  // gap. Both directions, matching the bell: if either of you has blocked the other, the room is
  // not offered. Signed-out viewers have no relationships, so there is nothing to filter and the
  // predicate is simply absent — which is also why this cannot be pushed into a shared WHERE.
  const blockGate = viewerId
    ? ` AND NOT EXISTS (
         SELECT 1 FROM blocks bl
         WHERE (bl.blocker_id = ? AND bl.blocked_id = r.host_id)
            OR (bl.blocker_id = r.host_id AND bl.blocked_id = ?))`
    : "";

  const binds: unknown[] = [];
  if (viewerId) binds.push(viewerId, viewerId);
  binds.push(cutoff);
  if (viewerId) binds.push(viewerId, viewerId);
  // The keyset predicate, recent only. Strictly after the cursor row in the SAME total order.
  let keyset = "";
  const after = sort === "recent" ? decodeCursor(opts.cursor) : null;
  if (after) {
    keyset = ` AND (r.started_at < ? OR (r.started_at = ? AND r.host_id < ?))`;
    binds.push(after.startedAt, after.startedAt, after.hostId);
  }
  binds.push(probe);

  const r = await db
    .prepare(
      `SELECT ${cols}${relCol}
       FROM rooms r
       JOIN users u ON u.id = r.host_id
       ${relJoin}
       WHERE r.live = 1 AND r.last_seen > ? AND u.handle IS NOT NULL${blockGate}${keyset}
       ${order} LIMIT ?`,
    )
    .bind(...binds)
    .all<LiveRoom & { hostId: string }>();

  const rows = r.results ?? [];
  const truncated = rows.length > limit;
  const kept = rows.slice(0, limit);
  const last = kept[kept.length - 1];
  // A cursor only exists where paging is coherent, and only when there IS a next page.
  const nextCursor =
    sort === "recent" && truncated && last?.startedAt != null ? encodeCursor(last.startedAt, last.hostId) : null;
  // host_id is an internal id and does not belong in a public payload — it rides only inside the
  // opaque cursor. Stripped here so no caller can accidentally serialise it.
  const roomsOut = kept.map(({ hostId: _hostId, ...room }) => room as LiveRoom);
  return { rooms: roomsOut, truncated, limit, nextCursor };
}

/** `<startedAt>:<hostId>` — split on the FIRST colon only, so a host id containing one is safe. */
function encodeCursor(startedAt: number, hostId: string): string {
  return `${startedAt}:${hostId}`;
}
function decodeCursor(c: string | null | undefined): { startedAt: number; hostId: string } | null {
  if (!c) return null;
  const i = c.indexOf(":");
  if (i <= 0) return null;
  const startedAt = Number(c.slice(0, i));
  const hostId = c.slice(i + 1);
  // A malformed cursor reads as NO cursor — the first page — rather than throwing or, worse,
  // binding NaN and silently matching nothing.
  if (!Number.isFinite(startedAt) || !hostId) return null;
  return { startedAt, hostId };
}

/** The notifications "Live now" source: rooms that the VIEWER follows that are broadcasting
 *  + fresh, newest-live first. Fan-out-on-read — a celebrity going live costs one room row,
 *  readers pay O(following ∩ live). Blocks-gated both directions (defense-in-depth: a block
 *  already deletes the follow edge, but enforce at read so the bell can never leak a blocker's
 *  live status). `startedAt` drives the client's "new since I last looked" badge. */
/** ★ NOT INTERCHANGEABLE WITH liveRooms, however much the two look alike — and thread 0c98985c
 *  called this "pure duplication" of it, which is wrong in the one direction that matters.
 *
 *  This read is BLOCKS-GATED in both directions and the public directory is not. Sourcing the
 *  bell from /api/rooms/live to save a query would put a blocked host's live room straight into
 *  the blocker's notifications — a safety regression bought with one saved D1 read. The gate is
 *  defence-in-depth (a block already deletes the follow edge) and defence-in-depth is exactly
 *  what you do not delete because it looks redundant.
 *
 *  The ORDER BY ends in host_id, the rooms PK, for the same reason as the directory's: started_at
 *  alone is not unique, so which of two rooms started in the same millisecond survives LIMIT 50
 *  was arbitrary and could differ between two identical calls.
 *
 *  NOTE the cap is silent: past 50 simultaneously-live followed hosts the bell truncates with no
 *  signal, the same shape 7089813 fixed in the directory. Left as-is deliberately — following 50
 *  people who are live AT ONCE is not a state this app reaches — but it is the same defect and
 *  should be fixed the same way if the bell ever grows a "see all". */
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
       ORDER BY r.started_at DESC, r.host_id DESC LIMIT 50`,
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
