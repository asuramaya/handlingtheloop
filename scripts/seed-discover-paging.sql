-- SEED ENOUGH PUBLISHED SETS TO CROSS /api/sets/discover's 60-ROW CAP.
--
-- The sets directory's keyset paging could never be exercised locally, because nobody has 61
-- published sets on a dev machine — so the page boundary, the one place a keyset cursor goes wrong,
-- was only ever covered by unit tests over a fake D1. This clones the newest real published set 70
-- times with descending published_at, which is all the query orders on.
--
--   npx wrangler d1 execute htl-db --local --file scripts/seed-discover-paging.sql
--   curl -s localhost:8787/api/sets/discover                 # 60 rows, truncated, a cursor
--   curl -s "localhost:8787/api/sets/discover?cursor=<that>" # the remainder, no gap, no repeat
--   npx wrangler d1 execute htl-db --local --command "DELETE FROM sets WHERE id LIKE 'pageseed-%';"
--
-- ★ CLEAN UP AFTER YOURSELF. The dev database is shared with whoever else is working in this tree;
-- 70 fake sets left behind is somebody else's confusing afternoon. Every row this writes is
-- prefixed `pageseed-` so the delete above is exact.
INSERT INTO sets (id, host_id, title, genre, status, duration, tracks, tracklist, cover_video, engine_ver, bytes, created_at, published_at)
WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < 70),
src AS (SELECT * FROM sets WHERE status='published' ORDER BY published_at DESC LIMIT 1)
SELECT 'pageseed-' || printf('%03d', n.i), src.host_id, 'Paging seed ' || printf('%03d', n.i), src.genre,
       'published', src.duration, src.tracks, src.tracklist, src.cover_video, src.engine_ver, src.bytes,
       src.created_at, src.published_at - n.i * 1000
FROM n, src;
