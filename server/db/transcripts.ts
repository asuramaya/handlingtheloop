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

// ---- community-pooled lyric transcripts (Whisper-on-vocal-stem; migrations 0009 + 0026) ----
// The PRIMARY lyrics source: one desktop GPU decodes a track's vocal stem and contributes
// here, so every later device + repeat play gets accurate, track-timed lyrics for free.
// The `captions` table above is the fallback.
//
// ★ CONVERGENCE (the same contract track_analysis has, see analysis.ts): every row carries the
// transcript-FORMAT version (`ver` = the client's LYRICS_VER) that produced it.
//   READ  — rank by ver first, so a NEWER format always beats an older one; only then prefer the
//           larger `small` model, then the newest write. Without the ver term a garbage `small`
//           row would outrank a good `base` one forever, purely because of its model name.
//   WRITE — DON'T-DOWNGRADE: an existing row is overwritten only when the incoming ver is >= the
//           stored one. Paired with the client re-decoding whenever the pooled ver is behind its
//           own, the pool converges monotonically UPWARD: a stale transcript is repaired by the
//           first capable device that plays the track, and a client on a stale tab can no longer
//           stomp a better transcript with a worse one.
export interface LyricsRow {
  model: string;
  lang: string;
  conf: number;
  ver: number;
  lines: { start: number; end: number; text: string; words?: { t: number; w: string; d?: number }[] }[];
}
// Rank the pooled transcripts for a track and serve the best one. FORMAT VERSION leads (a newer
// aligner beats a better model on stale times — see the convergence contract), then MODEL QUALITY,
// then recency. The model rank is written out rather than compared to one favoured id, because the
// lineup changes: it used to be `(model = 'small') DESC`, which as soon as a stronger model shipped
// would have quietly preferred the WEAKER transcript over it forever. Unknown/retired ids (e.g.
// "base", dropped for being poor at singing) sort last, and are still served if they're all we have.
const MODEL_RANK = "CASE model WHEN 'turbo' THEN 3 WHEN 'small' THEN 2 WHEN 'base' THEN 1 ELSE 0 END";
export async function getLyrics(db: D1Database, videoId: string): Promise<LyricsRow | null> {
  const row = await db
    .prepare(
      `SELECT model, lang, conf, ver, lines FROM lyrics WHERE video_id = ? ORDER BY ver DESC, ${MODEL_RANK} DESC, created_at DESC LIMIT 1`,
    )
    .bind(videoId)
    .first<{ model: string; lang: string; conf: number; ver: number; lines: string }>();
  if (!row?.lines) return null;
  try {
    const lines = JSON.parse(row.lines);
    return Array.isArray(lines) ? { model: row.model, lang: row.lang, conf: row.conf, ver: row.ver ?? 1, lines } : null;
  } catch {
    return null;
  }
}
export async function putLyrics(
  db: D1Database,
  v: { videoId: string; model: string; lang: string; conf: number; ver?: number; lines: unknown; contributor?: string | null },
): Promise<void> {
  const ver = v.ver ?? 1;
  // A fresh row always inserts; an existing row updates ONLY when this version is >= the stored
  // one. The WHERE on the conflict clause is what makes the write non-destructive.
  await db
    .prepare(
      `INSERT INTO lyrics (video_id, model, lang, conf, ver, lines, contributor, created_at) VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(video_id, model) DO UPDATE SET
         lang = excluded.lang, conf = excluded.conf, ver = excluded.ver, lines = excluded.lines,
         contributor = excluded.contributor, created_at = excluded.created_at
       WHERE excluded.ver >= lyrics.ver`,
    )
    .bind(v.videoId, v.model, v.lang, v.conf, ver, JSON.stringify(v.lines), v.contributor ?? null, now())
    .run();
}
// Takedown lever — drop every pooled transcript for a video (all models).
export async function deleteLyrics(db: D1Database, videoId: string): Promise<void> {
  await db.prepare("DELETE FROM lyrics WHERE video_id = ?").bind(videoId).run();
}
