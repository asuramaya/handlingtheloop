-- Crowdsourced analysis layer: the legally-clean dataset. Every client that
-- analyzes a track contributes its BPM / key / beatgrid here (facts/features about
-- the recording, not the recording). This is what gets promoted to a public
-- HuggingFace dataset later. Keyed by video_id, same as the community index.
-- Apply with:  wrangler d1 migrations apply htl-db [--remote]

CREATE TABLE IF NOT EXISTS track_analysis (
  video_id    TEXT PRIMARY KEY,
  bpm         REAL,
  music_key   TEXT,                      -- Camelot code, e.g. "8B"
  key_name    TEXT,                      -- musical name, e.g. "C" / "Am"
  beat_offset REAL,                      -- first-beat time (s); with bpm = the grid
  duration    INTEGER,                   -- seconds
  version     INTEGER NOT NULL DEFAULT 1, -- analysis-algorithm version
  updated_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_analysis_updated ON track_analysis(updated_at DESC);
