// Sampler GLOBAL pads (the 12 master-routed slots on the sampler strip): per-account
// uploaded audio clips. Bytes live in R2 at `samples/{userId}/{id}`; the user_samples
// table indexes them (one row per (user, pad) — uploading replaces the pad's old clip).
// Deck-region pads ("play X→Y" of a loaded track, 8 per deck) are positions only and live
// client-side, so they never touch this. Guards: ≤30s (client-validated, stored) and
// ≤12MB (enforced here — the real cap, since a Worker can't decode audio to check length).
import { readSessionId } from "./session";
import { userBySession, type D1Database, type User } from "./db";
import { json } from "./http";
import { STEM_DOWNLOAD_CONTENT_TYPE, DOWNLOAD_SAFE_HEADERS } from "./security";

export const MAX_SAMPLE_BYTES = 12 * 1024 * 1024; // 12 MB — fits a 30s 48k/24-bit lossless clip
export const MAX_SAMPLE_MS = 30_000;
// The 12 master-routed strip slots (g0..g11). `pad` is a free TEXT column keyed by
// (user, pad), so widening the set needs no migration — just accept the new ids.
const GLOBAL_PADS = new Set(Array.from({ length: 12 }, (_, i) => `g${i}`));
const MAX_NAME = 80;

// R2 binding (the worker's interface omits delete(); we need it for pad replace).
interface SampleBucket {
  get(key: string): Promise<{ body: ReadableStream; size: number; httpMetadata?: { contentType?: string } } | null>;
  put(key: string, value: ArrayBuffer | Uint8Array, opts?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  delete(key: string): Promise<void>;
}
// Minimal DjRoom namespace surface (structurally satisfied by the Worker's env.ROOM) — just enough
// to address a room by host id and ask whether a requester is a participant (#48).
interface RoomNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(req: Request): Promise<Response> };
}
export interface SampleEnv {
  DB?: D1Database;
  AUDIO?: SampleBucket;
  ROOM?: RoomNamespace; // to authorize a session GUEST fetching the HOST's clip (#48)
}

interface SampleRow {
  id: string;
  user_id: string; // the clip's owner — needed to authorize a non-owner (session-guest) audio fetch
  pad: string;
  name: string;
  r2_key: string;
  content_type: string | null;
  duration_ms: number | null;
  bytes: number | null;
  created_at: number;
}

// CREATE-IF-MISSING so the route works before the migration is applied to a live DB
// (mirrors ensureUserPlays in db.ts). Runs once per worker instance.
let ensured = false;
async function ensureUserSamples(db: D1Database): Promise<void> {
  if (ensured) return;
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS user_samples (
         id TEXT PRIMARY KEY, user_id TEXT NOT NULL, pad TEXT NOT NULL,
         name TEXT NOT NULL, r2_key TEXT NOT NULL, content_type TEXT,
         duration_ms INTEGER, bytes INTEGER, created_at INTEGER NOT NULL,
         UNIQUE (user_id, pad))`,
    )
    .run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_user_samples_user ON user_samples(user_id)").run();
  ensured = true;
}

const dto = (r: SampleRow) => ({ id: r.id, pad: r.pad, name: r.name, durationMs: r.duration_ms, bytes: r.bytes, createdAt: r.created_at });

// A session GUEST may fetch the HOST's global sample clip: authorize by asking the host's DjRoom
// whether the requester is a JOINED participant. The acct is un-forgeable (the Worker stamps it on
// every socket from the authed session), so this can't be spoofed. Fails CLOSED on any error /
// missing binding (e.g. plain `vite` dev with no ROOM) — the owner path is unaffected.
async function isSessionMember(env: SampleEnv, ownerId: string, requesterId: string): Promise<boolean> {
  if (!env.ROOM || !ownerId || !requesterId) return false;
  try {
    const stub = env.ROOM.get(env.ROOM.idFromName(`home:${ownerId}`));
    const res = await stub.fetch(new Request(`https://room/internal/ismember?acct=${encodeURIComponent(requesterId)}`));
    if (!res.ok) return false;
    return !!((await res.json()) as { member?: boolean }).member;
  } catch {
    return false;
  }
}

/** Routes under /api/samples (all account-gated). Returns null if the path isn't ours.
 *   GET    /api/samples            → list the signed-in user's global-pad samples
 *   POST   /api/samples?pad&name&durationMs  (raw audio body) → upload, replacing the pad
 *   GET    /api/samples/:id/audio  → the clip's bytes (owner only)
 *   DELETE /api/samples/:id        → remove the clip (R2 + index) */
export async function handleSampleRoute(url: URL, req: Request, env: SampleEnv): Promise<Response | null> {
  if (url.pathname !== "/api/samples" && !url.pathname.startsWith("/api/samples/")) return null;
  if (!env.DB || !env.AUDIO) return json(503, { error: "storage unavailable" });

  const sid = readSessionId(req);
  const user: User | null = sid ? await userBySession(env.DB, sid) : null;
  if (!user) return json(401, { error: "sign in first" });
  await ensureUserSamples(env.DB);
  const db = env.DB;
  const bucket = env.AUDIO;

  // /api/samples/:id  and  /api/samples/:id/audio
  const sub = url.pathname.slice("/api/samples".length); // "" | "/:id" | "/:id/audio"
  if (sub) {
    const parts = sub.split("/").filter(Boolean); // [":id"] | [":id","audio"]
    const id = parts[0];
    const wantAudio = parts[1] === "audio";
    // The audio BYTES may be served to a session GUEST (the host's clip), so look the row up
    // owner-AGNOSTICALLY for that path and authorize via room membership below. Metadata + DELETE
    // stay strictly owner-scoped — the user_id bind turns a non-owner's row into a 404.
    const row = wantAudio
      ? await db.prepare("SELECT id, user_id, pad, name, r2_key, content_type, duration_ms, bytes, created_at FROM user_samples WHERE id = ?").bind(id).first<SampleRow>()
      : await db.prepare("SELECT id, user_id, pad, name, r2_key, content_type, duration_ms, bytes, created_at FROM user_samples WHERE id = ? AND user_id = ?").bind(id, user.id).first<SampleRow>();
    if (!row) return json(404, { error: "not found" });

    if (wantAudio) {
      if (req.method !== "GET") return json(405, { error: "GET only" });
      // Owner always; otherwise the requester must be a JOINED participant of the owner's session.
      if (row.user_id !== user.id && !(await isSessionMember(env, row.user_id, user.id))) {
        return json(403, { error: "not a participant of this clip's session" });
      }
      const obj = await bucket.get(row.r2_key);
      if (!obj) return json(404, { error: "audio missing" });
      // Never replay the uploader's stored Content-Type. A sample is owner-scoped, but it's still
      // served from our origin, so a clip stored as text/html or image/svg+xml would be self-XSS.
      // Pin a fixed opaque type + nosniff + attachment (the same posture as cached stems —
      // server/security.ts); the client fetches the bytes and decodes via Web Audio, which sniffs
      // the container header and ignores the Content-Type entirely (see useSampler.ts).
      return new Response(obj.body, {
        headers: {
          "content-type": STEM_DOWNLOAD_CONTENT_TYPE,
          "content-length": String(obj.size),
          "cache-control": "private, max-age=31536000",
          ...DOWNLOAD_SAFE_HEADERS,
        },
      });
    }
    if (req.method === "DELETE") {
      await bucket.delete(row.r2_key).catch(() => {});
      await db.prepare("DELETE FROM user_samples WHERE id = ? AND user_id = ?").bind(id, user.id).run();
      return json(200, { ok: true });
    }
    return json(405, { error: "method not allowed" });
  }

  // /api/samples
  if (req.method === "GET") {
    const res = await db
      .prepare("SELECT id, user_id, pad, name, r2_key, content_type, duration_ms, bytes, created_at FROM user_samples WHERE user_id = ? ORDER BY pad")
      .bind(user.id)
      .all<SampleRow>();
    return json(200, { samples: (res.results ?? []).map(dto) });
  }

  if (req.method === "POST") {
    const pad = url.searchParams.get("pad") || "";
    if (!GLOBAL_PADS.has(pad)) return json(400, { error: "bad pad" });
    const name = (url.searchParams.get("name") || "Sample").slice(0, MAX_NAME);
    const durationMs = Math.round(Number(url.searchParams.get("durationMs")) || 0);
    if (durationMs <= 0 || durationMs > MAX_SAMPLE_MS) return json(400, { error: `sample must be ≤ ${MAX_SAMPLE_MS / 1000}s` });

    const buf = await req.arrayBuffer();
    if (buf.byteLength === 0) return json(400, { error: "empty upload" });
    if (buf.byteLength > MAX_SAMPLE_BYTES) return json(413, { error: `sample must be ≤ ${Math.round(MAX_SAMPLE_BYTES / 1024 / 1024)} MB` });
    const contentType = req.headers.get("content-type") || "audio/wav";

    // Replace whatever was on this pad (delete its R2 object + row first).
    const prev = await db.prepare("SELECT r2_key FROM user_samples WHERE user_id = ? AND pad = ?").bind(user.id, pad).first<{ r2_key: string }>();
    if (prev) {
      await bucket.delete(prev.r2_key).catch(() => {});
      await db.prepare("DELETE FROM user_samples WHERE user_id = ? AND pad = ?").bind(user.id, pad).run();
    }

    const id = crypto.randomUUID();
    const r2Key = `samples/${user.id}/${id}`;
    const createdAt = Date.now();
    await bucket.put(r2Key, buf, { httpMetadata: { contentType } });
    await db
      .prepare("INSERT INTO user_samples (id, user_id, pad, name, r2_key, content_type, duration_ms, bytes, created_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .bind(id, user.id, pad, name, r2Key, contentType, durationMs, buf.byteLength, createdAt)
      .run();
    return json(200, { id, pad, name, durationMs, bytes: buf.byteLength, createdAt });
  }

  return json(405, { error: "method not allowed" });
}
