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
  energy?: number | null;
  version?: number; // the algorithm that produced the row; THIRD_PARTY_ANALYSIS_VERSION = not ours
}

/** The version a contribution carries when it did NOT come from our detector — the /api/features
 *  lane, which is a third-party ISRC lookup (MusicBrainz → AcousticBrainz) with bpm/key and nothing
 *  else. It must sit BELOW the schema default (`version INTEGER NOT NULL DEFAULT 1`, migration
 *  0004), and that is the whole point of the number.
 *
 *  ★ THE DON'T-DOWNGRADE GUARD IS `>=`, SO A TIE IS AN OVERWRITE, and this lane used to tie with
 *  every default-version row by omitting `version` entirely. Measured on a real local D1 (wrangler
 *  d1 execute --local), a single features call against a version-1 row that had been derived from
 *  decoded audio: bpm 128 → 64, music_key 8A → 3A, and key_name / beat_offset / DURATION all set to
 *  NULL, because the summary statement writes every column from `excluded` and this caller supplies
 *  three of them. The `grid` column survived untouched — the grid write is skipped when no grid is
 *  offered — so the row came out of it holding a beatgrid, a bpm that disagrees with that grid, and
 *  no duration to check the grid against. A v4 row was untouched in the same run: the guard works
 *  exactly where the versions differ and is a no-op where they tie.
 *
 *  Which bpm is the better number is a separate question nobody has measured. The defect does not
 *  depend on the answer: the row ends up internally inconsistent either way, and the field that
 *  matters most is the one nulled rather than the one replaced — `duration` is what mayReuseGrid
 *  uses to decide whether a grid describes this audio at all (src/App/gridReuse.ts).
 *
 *  0 rather than a flag column because the guard already reads this axis. A row at 0 is behind every
 *  reader's ANALYSIS_VERSION, so mayReuseGrid answers `behind-version`, the load derives locally and
 *  re-contributes at the real version — the same lazy convergence the version gate was built for.
 *  A fresh track still gets its third-party row: ON CONFLICT's WHERE gates the UPDATE branch only,
 *  never the INSERT. */
export const THIRD_PARTY_ANALYSIS_VERSION = 0;

/** Contribute/refresh a track's analysis (BPM/key/grid). Idempotent per video.
 *  DON'T-DOWNGRADE: the row is overwritten only when the incoming `version` is >= the stored one,
 *  so an older client can never stomp a grid produced by a newer detector. Combined with the load
 *  path re-deriving whenever the stored version is behind, the pool converges monotonically to the
 *  newest algorithm in circulation — see the htl-metadata-convergence design note. */
export async function upsertAnalysis(
  db: D1Database,
  a: { videoId: string; bpm?: number | null; key?: string | null; keyName?: string | null; beatOffset?: number | null; duration?: number | null; grid?: string | null; palette?: string | null; energy?: number | null; version?: number },
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
  // Perceptual energy — same pattern again (0029).
  if (a.energy != null && Number.isFinite(a.energy)) {
    try {
      await db
        .prepare(`UPDATE track_analysis SET energy=? WHERE video_id=? AND ? >= version`)
        .bind(a.energy, a.videoId, version)
        .run();
    } catch {
      /* energy column not migrated yet — lands after 0029 */
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
  const base = "video_id, bpm, music_key, key_name, beat_offset, duration";
  // `energy` is a late column (0029). Naming it in the SELECT would throw the WHOLE batch on a
  // deployment whose code is ahead of its migrations — and this endpoint feeds the auto-mix pool,
  // so failing it closed would silently un-analyse every candidate. Ask for energy, fall back to
  // the columns that have always existed.
  try {
    const r = await db
      .prepare(`SELECT ${base}, energy FROM track_analysis WHERE video_id IN (${ph})`)
      .bind(...clean)
      .all<TrackAnalysisRow>();
    return r.results ?? [];
  } catch {
    const r = await db
      .prepare(`SELECT ${base} FROM track_analysis WHERE video_id IN (${ph})`)
      .bind(...clean)
      .all<TrackAnalysisRow>();
    return r.results ?? [];
  }
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

/** Page of analysis rows (for the HF export).
 *
 *  ★ `version` IS IN THE SELECT BECAUSE IT IS THE ONLY PROVENANCE THE ROW CARRIES. The export
 *  publishes this table as "derived features ... generated by Handling The Loop", which is true of a
 *  row our detector produced from decoded audio and NOT true of one the /api/features lane copied
 *  out of MusicBrainz/AcousticBrainz. Those were indistinguishable until THIRD_PARTY_ANALYSIS_VERSION
 *  gave them a number of their own; dropping the column here would publish the mixture and keep them
 *  indistinguishable downstream, where nobody can tell and nobody knows to ask.
 *
 *  The ORDER BY is total — `video_id` is the table's primary key — so paging by OFFSET cannot repeat
 *  or skip a row when `updated_at` ties, which it does in bulk for rows written in the same second. */
export interface ExportAnalysisRow extends TrackAnalysisRow {
  /** NOT optional, unlike TrackAnalysisRow's. The column is `NOT NULL` and this query names it, so
   *  the export never has to publish "absent" or "null" as a third, undocumented state of a field
   *  whose whole job is to be trusted. Metron caught the `?? null` that would have allowed one. */
  version: number;
}

export async function listAnalysis(db: D1Database, limit = 1000, offset = 0): Promise<ExportAnalysisRow[]> {
  const r = await db
    .prepare("SELECT video_id, bpm, music_key, key_name, beat_offset, duration, version FROM track_analysis ORDER BY updated_at DESC, video_id DESC LIMIT ? OFFSET ?")
    .bind(Math.max(1, Math.min(limit, 5000)), Math.max(0, offset))
    .all<ExportAnalysisRow>();
  return r.results ?? [];
}

/** How many rows carry the SHAPE of the old third-party lane but not its label.
 *
 *  ★ THE PROVENANCE COLUMN HAS A BLIND SPOT AND THIS SIZES IT. /api/features wrote no `version` at
 *  all until c22d16c, so it took migration 0004's column default of 1 — meaning an unknown number of
 *  rows sitting at `version: 1` are public-database lookups, indistinguishable from a decoded-audio
 *  measurement by the only column that distinguishes anything. THIRD_PARTY_ANALYSIS_VERSION labels
 *  the lane going forward and can say nothing about what it already wrote.
 *
 *  The shape is the estimator: that lane supplied bpm/key and NOTHING else, so its rows carry no
 *  key_name, no beat_offset and no duration. Metron's production census licenses it from the other
 *  side — 0 of 662 decoded-audio pool rows lacked a duration, so a decoded row essentially always
 *  has one and this filter's false-positive rate is low. A result he published for a different
 *  question turns out to bound this one.
 *
 *  It is an ESTIMATE and the name says so. A pre-versioning row whose contributor crashed between
 *  the summary write and the grid write would look the same, and nothing distinguishes them now. */
export async function countUnlabelledLookups(db: D1Database): Promise<number | null> {
  try {
    const r = await db
      .prepare(
        `SELECT COUNT(*) AS n FROM track_analysis
          WHERE version = 1 AND duration IS NULL AND beat_offset IS NULL AND key_name IS NULL
            AND (bpm IS NOT NULL OR music_key IS NOT NULL)`,
      )
      .first<{ n: number }>();
    return r?.n ?? 0;
  } catch {
    return null; // never fail an export over its own footnote
  }
}

/** How many rows actually carry each published field.
 *
 *  ★ THE HEADLINE NAMES THREE FEATURES AND THE ROWS DO NOT UNIFORMLY CARRY THEM. "BPM, musical key
 *  (Camelot), and beat-grid offset" reads as a promise about every row, and a lookup-lane row has
 *  bpm and key and NOTHING else — `beat_offset` is null there by construction, because that lane
 *  supplies two fields and the summary write stores what it is given.
 *
 *  This is the same overclaim as the one that started this file's provenance work, one field along:
 *  a sentence asserting uniformity the data does not have. It is cheap to stop asserting it now that
 *  the README is a pure function of measured facts rather than a literal — so the counts ride with
 *  the export like the blind-spot count, and a consumer learns what fraction of rows carry what
 *  before they download anything.
 *
 *  One query, so the four numbers are of the SAME table at the SAME instant: four counts taken
 *  separately could be read between writes and disagree with each other and with `tracks`. */
export async function countFieldCoverage(db: D1Database): Promise<{ total: number; bpm: number; key: number; beatOffset: number; duration: number } | null> {
  try {
    const r = await db
      .prepare(
        // ★ THE DENOMINATOR RIDES IN THE SAME STATEMENT AS THE NUMERATORS. The four counts were
        // already one query so they could not disagree with each other across a write — and were
        // then divided, in the README, by a row count taken from the PAGED READ that runs after
        // them. Care taken inside the measurement made the gap between it and its denominator
        // easier to miss, not harder. This table is live: a contribution lands on any play and the
        // admin panel beside this button DELETES rows, so it moves in both directions, and a
        // shrink publishes a percentage above 100.
        `SELECT COUNT(*) AS total, COUNT(bpm) AS bpm, COUNT(music_key) AS key, COUNT(beat_offset) AS beatOffset, COUNT(duration) AS duration
           FROM track_analysis`,
      )
      .first<{ total: number; bpm: number; key: number; beatOffset: number; duration: number }>();
    return r ?? null;
  } catch {
    return null; // never fail an export over its own footnote
  }
}

// ── ISRC → videoId resolution memo (auto-mix provider radio) ────────────────────────────────────
// See migrations/0028_isrc_video.sql. A recording's ISRC is permanent, so this mapping never
// expires: it exists purely to keep the TIDAL radio tier from spending a YouTube search per
// result per fill, which is what made that tier too expensive to actually run.

export interface IsrcVideoRow {
  isrc: string;
  video_id: string;
  title: string | null;
  artist: string | null;
}

/** Look up a batch of ISRCs. Caps at 100 bindings, matching getIdentitiesByIds. */
export async function getIsrcVideos(db: D1Database, isrcs: string[]): Promise<IsrcVideoRow[]> {
  const clean = Array.from(new Set(isrcs.filter((s) => typeof s === "string" && s.length > 0 && s.length <= 32))).slice(0, 100);
  if (!clean.length) return [];
  const ph = clean.map(() => "?").join(",");
  const r = await db
    .prepare(`SELECT isrc, video_id, title, artist FROM isrc_video WHERE isrc IN (${ph})`)
    .bind(...clean)
    .all<IsrcVideoRow>();
  return r.results ?? [];
}

/** Record resolutions. Last write wins — a re-resolution means the earlier videoId went away. */
export async function putIsrcVideos(
  db: D1Database,
  rows: { isrc: string; videoId: string; title?: string | null; artist?: string | null }[],
): Promise<void> {
  const clean = rows.filter((r) => r.isrc && /^[\w-]{11}$/.test(r.videoId)).slice(0, 50);
  if (!clean.length) return;
  const t = now();
  const stmt = db.prepare(
    `INSERT INTO isrc_video (isrc, video_id, title, artist, updated_at) VALUES (?,?,?,?,?)
     ON CONFLICT(isrc) DO UPDATE SET
       video_id=excluded.video_id, title=excluded.title, artist=excluded.artist, updated_at=excluded.updated_at`,
  );
  // Sequential rather than batched: the shared D1 shim in core.ts deliberately exposes only
  // prepare/bind/first/all/run, and this is a write-behind path off the request's critical path,
  // so a handful of round trips costs the caller nothing.
  for (const r of clean) {
    await stmt.bind(r.isrc, r.videoId, r.title ?? null, r.artist ?? null, t).run();
  }
}
