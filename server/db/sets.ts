// Recorded sets (Epic G1a): the D1 index over the R2-stored broadcast recipes. A "set"
// is a persisted broadcast digest (commands only — see migration 0016); the log blob is
// in R2 at sets/<id>.json, this table is what you query (a host's history, the published
// directory). The host's client captures + POSTs; these helpers are the model.
import { type D1Database, now, uuid } from "./core";

let setsReady = false;
export async function ensureSetsTable(db: D1Database): Promise<void> {
  if (setsReady) return;
  await db
    .prepare(
      "CREATE TABLE IF NOT EXISTS sets (id TEXT PRIMARY KEY, host_id TEXT NOT NULL, title TEXT, genre TEXT, status TEXT NOT NULL DEFAULT 'draft', duration INTEGER NOT NULL DEFAULT 0, tracks INTEGER NOT NULL DEFAULT 0, tracklist TEXT, cover_video TEXT, engine_ver INTEGER NOT NULL DEFAULT 0, bytes INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, published_at INTEGER, trim_start INTEGER, trim_end INTEGER)",
    )
    .run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_sets_host ON sets(host_id, created_at)").run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_sets_pub ON sets(status, published_at)").run();
  // Older tables (pre-0017) — add the trim columns if missing (idempotent, ignore "duplicate").
  for (const col of ["trim_start", "trim_end"]) {
    await db.prepare(`ALTER TABLE sets ADD COLUMN ${col} INTEGER`).run().catch(() => {});
  }
  setsReady = true;
}

/** One marker in a set's tracklist — what played + when (ms into the set). */
export interface SetTrack {
  videoId: string;
  title?: string | null;
  artist?: string | null;
  at: number; // ms from set start
}

export interface NewSet {
  hostId: string;
  title?: string | null;
  genre?: string | null;
  duration: number; // ms
  tracklist: SetTrack[];
  coverVideo?: string | null;
  engineVer: number;
  bytes: number; // log blob size
}

/** Insert a freshly-captured set as a private DRAFT. Returns the new id (also the R2 key). */
export async function createSet(db: D1Database, s: NewSet): Promise<string> {
  const id = uuid();
  await db
    .prepare(
      "INSERT INTO sets (id, host_id, title, genre, status, duration, tracks, tracklist, cover_video, engine_ver, bytes, created_at, published_at) VALUES (?,?,?,?,'draft',?,?,?,?,?,?,?,NULL)",
    )
    .bind(
      id,
      s.hostId,
      s.title ?? null,
      s.genre ?? null,
      Math.max(0, Math.floor(s.duration)),
      s.tracklist.length,
      JSON.stringify(s.tracklist),
      s.coverVideo ?? null,
      Math.max(0, Math.floor(s.engineVer)),
      Math.max(0, Math.floor(s.bytes)),
      now(),
    )
    .run();
  return id;
}

// The row, shaped for an API card (camelCase). `tracklist` is parsed lazily by the reader.
export interface SetRow {
  id: string;
  hostId: string;
  title: string | null;
  genre: string | null;
  status: "draft" | "published";
  duration: number;
  tracks: number;
  tracklist: string | null; // raw JSON; parse on read
  coverVideo: string | null;
  engineVer: number;
  bytes: number;
  createdAt: number;
  publishedAt: number | null;
  trimStart: number | null; // ms — performance in-point (null = start of recording)
  trimEnd: number | null; // ms — performance out-point (null = end of recording)
}

const SELECT =
  "SELECT id, host_id AS hostId, title, genre, status, duration, tracks, tracklist, cover_video AS coverVideo, engine_ver AS engineVer, bytes, created_at AS createdAt, published_at AS publishedAt, trim_start AS trimStart, trim_end AS trimEnd FROM sets";

export async function getSet(db: D1Database, id: string): Promise<SetRow | null> {
  return db.prepare(`${SELECT} WHERE id = ?`).bind(id).first<SetRow>();
}

/** A host's own sets, newest first. `includeDrafts` is true only for the owner's view. */
export async function setsByHost(db: D1Database, hostId: string, includeDrafts: boolean, limit = 100): Promise<SetRow[]> {
  const where = includeDrafts ? "WHERE host_id = ?" : "WHERE host_id = ? AND status = 'published'";
  const r = await db.prepare(`${SELECT} ${where} ORDER BY created_at DESC LIMIT ?`).bind(hostId, limit).all<SetRow>();
  return r.results ?? [];
}

/** The published-sets directory for Discover (newest published first). */
export async function publishedSets(db: D1Database, limit = 100): Promise<SetRow[]> {
  const r = await db.prepare(`${SELECT} WHERE status = 'published' ORDER BY published_at DESC LIMIT ?`).bind(limit).all<SetRow>();
  return r.results ?? [];
}

// A set row carrying its host's public identity — for the Discover directory (many hosts).
export interface DiscoverSetRow extends SetRow {
  handle: string | null;
  displayName: string | null;
  avatar: string | null;
}
/** Published sets across all hosts (with handles), newest first — the Discover Sets facet. */
export async function discoverSets(db: D1Database, limit = 60): Promise<DiscoverSetRow[]> {
  const r = await db
    .prepare(
      `SELECT s.id, s.host_id AS hostId, s.title, s.genre, s.status, s.duration, s.tracks, s.tracklist,
              s.cover_video AS coverVideo, s.engine_ver AS engineVer, s.bytes, s.created_at AS createdAt,
              s.published_at AS publishedAt, s.trim_start AS trimStart, s.trim_end AS trimEnd,
              u.handle, u.display_name AS displayName, COALESCE(u.avatar_url, u.avatar) AS avatar
       FROM sets s JOIN users u ON u.id = s.host_id
       WHERE s.status = 'published' AND u.handle IS NOT NULL
       ORDER BY s.published_at DESC LIMIT ?`,
    )
    .bind(limit)
    .all<DiscoverSetRow>();
  return r.results ?? [];
}

/** Flip a set's lifecycle state (G1b). Owner-scoped: the host_id guard makes it a no-op
 *  for anyone else. Stamps published_at on the draft→published transition. */
export async function setSetStatus(db: D1Database, id: string, hostId: string, status: "draft" | "published"): Promise<void> {
  const publishedAt = status === "published" ? now() : null;
  await db
    .prepare("UPDATE sets SET status = ?, published_at = ? WHERE id = ? AND host_id = ?")
    .bind(status, publishedAt, id, hostId)
    .run();
}

/** Rename a set (G1b). Owner-scoped; empty/null title → falls back to a default label. */
export async function setSetTitle(db: D1Database, id: string, hostId: string, title: string | null): Promise<void> {
  await db.prepare("UPDATE sets SET title = ? WHERE id = ? AND host_id = ?").bind(title, id, hostId).run();
}

/** Trim a set's performance in/out (ms; null clears). Owner-scoped (the host curates the tape). */
export async function setSetTrim(db: D1Database, id: string, hostId: string, start: number | null, end: number | null): Promise<void> {
  await db.prepare("UPDATE sets SET trim_start = ?, trim_end = ? WHERE id = ? AND host_id = ?").bind(start, end, id, hostId).run();
}

/** Discard a set (G1b). Owner-scoped; the caller deletes the R2 log alongside. */
export async function deleteSet(db: D1Database, id: string, hostId: string): Promise<void> {
  await db.prepare("DELETE FROM sets WHERE id = ? AND host_id = ?").bind(id, hostId).run();
}
