// Sampler GLOBAL pads (the 4 master-routed slots on the sampler strip): per-account
// uploaded audio clips. Bytes live in R2 at `samples/{userId}/{id}`; the user_samples
// table indexes them (one row per (user, pad) — uploading replaces the pad's old clip).
// Deck-region pads ("play X→Y" of a loaded track) are positions only and live
// client-side, so they never touch this. Guards: ≤30s (client-validated, stored) and
// ≤12MB (enforced here — the real cap, since a Worker can't decode audio to check length).
import { readSessionId } from "./session";
import { userBySession, type D1Database, type User } from "./db";

export const MAX_SAMPLE_BYTES = 12 * 1024 * 1024; // 12 MB — fits a 30s 48k/24-bit lossless clip
export const MAX_SAMPLE_MS = 30_000;
const GLOBAL_PADS = new Set(["g0", "g1", "g2", "g3"]); // the 4 master-routed strip slots
const MAX_NAME = 80;

// R2 binding (the worker's interface omits delete(); we need it for pad replace).
interface SampleBucket {
  get(key: string): Promise<{ body: ReadableStream; size: number; httpMetadata?: { contentType?: string } } | null>;
  put(key: string, value: ArrayBuffer | Uint8Array, opts?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  delete(key: string): Promise<void>;
}
export interface SampleEnv {
  DB?: D1Database;
  AUDIO?: SampleBucket;
}

interface SampleRow {
  id: string;
  pad: string;
  name: string;
  r2_key: string;
  content_type: string | null;
  duration_ms: number | null;
  bytes: number | null;
  created_at: number;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
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
    const row = await db
      .prepare("SELECT id, pad, name, r2_key, content_type, duration_ms, bytes, created_at FROM user_samples WHERE id = ? AND user_id = ?")
      .bind(id, user.id)
      .first<SampleRow>();
    if (!row) return json(404, { error: "not found" });

    if (parts[1] === "audio") {
      if (req.method !== "GET") return json(405, { error: "GET only" });
      const obj = await bucket.get(row.r2_key);
      if (!obj) return json(404, { error: "audio missing" });
      return new Response(obj.body, {
        headers: {
          "content-type": obj.httpMetadata?.contentType || row.content_type || "audio/wav",
          "content-length": String(obj.size),
          "cache-control": "private, max-age=31536000",
          "x-content-type-options": "nosniff",
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
      .prepare("SELECT id, pad, name, r2_key, content_type, duration_ms, bytes, created_at FROM user_samples WHERE user_id = ? ORDER BY pad")
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
