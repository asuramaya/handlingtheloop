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
// derivation beats an older one), then how the times were obtained, then recency.
//
// ★ AND THE WHISPER ERA IS NOT RANKED, IT IS REFUSED. Rows below FIRST_TRUSTWORTHY_VER were written
// by a generative model that INVENTED the words ("(crow cawing) (crow cawing) (crow cawing)"). The
// convergence contract says a stale transcript beats none — true when stale means worse TIMING,
// false when it means fiction. There is no version of "show it while we fix it" that is acceptable
// for made-up content, so the pool simply does not serve it.
const FIRST_TRUSTWORTHY_VER = 6;
// aligned = word-times measured against a real vocal stem · estimated = no line clock existed, so
// the times are derived without anchors · lrclib = the database's own line clock, un-refined.
const MODEL_RANK = "CASE model WHEN 'aligned' THEN 3 WHEN 'estimated' THEN 2 WHEN 'lrclib' THEN 1 ELSE 0 END";
export async function getLyrics(db: D1Database, videoId: string): Promise<LyricsRow | null> {
  const row = await db
    .prepare(
      `SELECT model, lang, conf, ver, lines FROM lyrics WHERE video_id = ? AND ver >= ${FIRST_TRUSTWORTHY_VER} ORDER BY ver DESC, ${MODEL_RANK} DESC, created_at DESC LIMIT 1`,
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
