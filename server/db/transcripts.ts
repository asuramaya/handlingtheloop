// Lyrics + caption caches. Persisted so a single lucky upstream pull / GPU decode
// serves every later request (any isolate/deck/user).
import { type D1Database, now } from "./core";

// --- Caption cache -------------------------------------------------------
// See migrations/0007_captions.sql.

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
