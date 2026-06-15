-- Acoustic-identity layer: the GLOBAL, permanent cache that maps a YouTube video to
-- its canonical recording (via Chromaprint → AcoustID → MusicBrainz). Keyed by
-- video_id like the rest. This is what keeps us from re-hitting AcoustID — the first
-- play of a track fingerprints + looks it up once; every play after (any user) reads
-- this row. A row with isrc/mbid NULL records "looked up, no match" so we don't
-- re-query unidentifiable uploads either.
-- Apply with:  wrangler d1 migrations apply htl-db [--remote]

CREATE TABLE IF NOT EXISTS track_identity (
  video_id   TEXT PRIMARY KEY,
  isrc       TEXT,            -- the global recording id (null = no match)
  mbid       TEXT,            -- MusicBrainz recording id
  artist     TEXT,            -- canonical artist (from AcoustID/MusicBrainz, not the uploader)
  title      TEXT,            -- canonical title
  source     TEXT,            -- "acoustid" | "none"
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_identity_updated ON track_identity(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_identity_isrc ON track_identity(isrc);
