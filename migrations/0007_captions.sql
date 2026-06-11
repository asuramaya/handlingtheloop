-- Durable cross-isolate cache for video captions. The upstream timedtext endpoint
-- is IP/session-bound and lands cues only ~1 in 5 tries from the datacenter, and a
-- worker's in-memory memo is per-isolate. Captions are immutable per video, so once
-- ANY request gets lucky we persist the cues and every later request (any isolate,
-- any deck, any user) serves them instantly. Only SUCCESSES are stored — an empty
-- result is indistinguishable from a flake, so we never cache "no captions".
CREATE TABLE IF NOT EXISTS captions (
  video_id   TEXT PRIMARY KEY,
  cues       TEXT NOT NULL, -- JSON array of {start,end,text}
  updated_at INTEGER NOT NULL
);
