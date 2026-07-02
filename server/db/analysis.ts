// Analysis layer (the crowdsourced BPM/key/grid dataset) + acoustic identity (the
// global AcoustID/ISRC cache).
import { type D1Database, now } from "./core";

export interface TrackAnalysisRow {
  video_id: string;
  bpm: number | null;
  music_key: string | null;
  key_name: string | null;
  beat_offset: number | null;
  duration: number | null;
}

/** Contribute/refresh a track's analysis (BPM/key/grid). Idempotent per video.
 *  DON'T-DOWNGRADE: the row is overwritten only when the incoming `version` is >= the stored one,
 *  so an older client can never stomp a grid produced by a newer detector. Combined with the load
 *  path re-deriving whenever the stored version is behind, the pool converges monotonically to the
 *  newest algorithm in circulation — see the htl-metadata-convergence design note. */
export async function upsertAnalysis(
  db: D1Database,
  a: { videoId: string; bpm?: number | null; key?: string | null; keyName?: string | null; beatOffset?: number | null; duration?: number | null; grid?: string | null; palette?: string | null; version?: number },
): Promise<void> {
  const version = a.version ?? 1;
  // The BPM/key summary write — unchanged shape, so it can NEVER be broken by the grid column.
  // A fresh row always inserts; an existing row updates only when this version is >= the stored one.
  await db
    .prepare(
      `INSERT INTO track_analysis (video_id, bpm, music_key, key_name, beat_offset, duration, version, updated_at)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(video_id) DO UPDATE SET
         bpm=excluded.bpm, music_key=excluded.music_key, key_name=excluded.key_name,
         beat_offset=excluded.beat_offset, duration=excluded.duration,
         version=excluded.version, updated_at=excluded.updated_at
       WHERE excluded.version >= track_analysis.version`,
    )
    .bind(a.videoId, a.bpm ?? null, a.key ?? null, a.keyName ?? null, a.beatOffset ?? null, a.duration ?? null, version, now())
    .run();
  // The full grid is a SEPARATE, self-healing write: if migration 0023 (the `grid` column) hasn't
  // applied yet, this throws and we swallow it — the summary above is already persisted. Once the
  // column exists, the grid lands. Skip when no grid is offered so a summary-only contributor
  // (e.g. the ISRC features path) never nulls a previously-stored grid. Same don't-downgrade guard
  // (`version >= current`): after the summary write the row's version is the survivor's, so the grid
  // only lands when this contribution won (or tied) — never overwriting a newer detector's grid.
  if (a.grid != null) {
    try {
      await db
        .prepare(`UPDATE track_analysis SET grid=? WHERE video_id=? AND ? >= version`)
        .bind(a.grid, a.videoId, version)
        .run();
    } catch {
      /* grid column not migrated yet — bpm/key already persisted, grid lands after the migration */
    }
  }
  // The album-art colour palette — same separate, guarded, self-healing write as the grid (0024).
  if (a.palette != null) {
    try {
      await db
        .prepare(`UPDATE track_analysis SET palette=? WHERE video_id=? AND ? >= version`)
        .bind(a.palette, a.videoId, version)
        .run();
    } catch {
      /* palette column not migrated yet — lands after 0024 */
    }
  }
}

export interface TrackAnalysisFull {
  bpm: number | null;
  music_key: string | null;
  key_name: string | null;
  beat_offset: number | null;
  duration: number | null;
  grid: string | null;
  palette: string | null;
  version: number;
}

/** Full stored analysis for ONE track (serialized grid + palette + algorithm version) — the
 *  cache-first load reads this to reuse a grid/palette instead of re-deriving/re-extracting. Returns
 *  null if unknown, or if the `grid`/`palette` columns haven't migrated yet (0023/0024, which apply
 *  together) — either way the caller derives locally, then re-contributes (self-healing). */
export async function getAnalysisFull(db: D1Database, videoId: string): Promise<TrackAnalysisFull | null> {
  if (!/^[\w-]{11}$/.test(videoId)) return null;
  try {
    return await db
      .prepare("SELECT bpm, music_key, key_name, beat_offset, duration, grid, palette, version FROM track_analysis WHERE video_id = ?")
      .bind(videoId)
      .first<TrackAnalysisFull>();
  } catch {
    return null; // grid/palette columns not migrated yet → treat as a miss, derive locally
  }
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
