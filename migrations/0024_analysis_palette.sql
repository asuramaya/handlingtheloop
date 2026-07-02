-- Store a per-track colour PALETTE (accent + low/mid/high band hues, extracted from the album art)
-- alongside the BPM/key/grid in the crowdsourced analysis layer, so the UI can theme each deck to the
-- loaded track's artwork instantly (from the song list, like bpm/key) instead of every client
-- re-extracting. Additive + nullable; written as a separate guarded UPDATE (like `grid`) so a
-- palette-less contribution never clobbers a stored palette. Deterministic per art → self-healing.
-- Apply with:  wrangler d1 migrations apply htl-db [--remote]

ALTER TABLE track_analysis ADD COLUMN palette TEXT;
