-- Store the FULL dynamic beatgrid (beats[]/downbeat/phrases, serialized JSON) alongside the
-- BPM/key summary in the crowdsourced analysis layer, so a cached track reloads WITH its grid
-- (skip the per-load beat-tracking) and the `version` that produced it is known — the seam a
-- neural detector (Beat This!, etc.) plugs into without re-running on every load. Additive +
-- nullable; the write path COALESCEs so a summary-only contribution never clobbers a stored grid.
-- Apply with:  wrangler d1 migrations apply htl-db [--remote]

ALTER TABLE track_analysis ADD COLUMN grid TEXT;
