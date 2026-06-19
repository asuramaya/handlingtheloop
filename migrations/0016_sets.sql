-- Recorded sets (Epic G1): a persisted broadcast "recipe" — COMMANDS ONLY, re-rendered
-- on device at replay (no stored audio, same ToS lane as a live broadcast). While a host
-- is live, their client captures the outbound digest (snapshot + intents + sparse position
-- ticks + automix) and POSTs it on broadcast-end; the log blob lands in R2 at sets/<id>.json
-- and this row indexes it. Capture-by-default → a private DRAFT; the host curates after
-- (Save/Publish/Discard in G1b). One host has many sets.
CREATE TABLE IF NOT EXISTS sets (
  id           TEXT PRIMARY KEY,              -- opaque set id; also the R2 log key (sets/<id>.json)
  host_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title        TEXT,
  genre        TEXT,
  status       TEXT NOT NULL DEFAULT 'draft', -- draft | published (lifecycle, G1b)
  duration     INTEGER NOT NULL DEFAULT 0,    -- set length in ms
  tracks       INTEGER NOT NULL DEFAULT 0,    -- distinct tracks played (for the card)
  tracklist    TEXT,                          -- JSON [{videoId,title,artist,at}] for the card (G2)
  cover_video  TEXT,                          -- a representative videoId for the card thumbnail
  engine_ver   INTEGER NOT NULL DEFAULT 0,    -- ENGINE_VERSION at capture (D5 replay-fidelity gate)
  bytes        INTEGER NOT NULL DEFAULT 0,    -- log blob size (housekeeping / quotas)
  created_at   INTEGER NOT NULL,              -- epoch ms the set was captured
  published_at INTEGER                        -- epoch ms status flipped to published (NULL while draft)
);
-- Profile history (a host's own sets, newest first) + Discover (published, newest first).
CREATE INDEX IF NOT EXISTS idx_sets_host ON sets(host_id, created_at);
CREATE INDEX IF NOT EXISTS idx_sets_pub ON sets(status, published_at);
