-- Community-pooled lyric transcripts. Whisper decodes a track's isolated vocal stem on a
-- desktop GPU and contributes the result here, so every later device — including phones
-- that can't run the model — and every repeat play gets accurate, track-timed lyrics
-- instantly, with no GPU work. One row per (video, model); newest contribution wins.
-- Sibling to the `captions` table (0007), which is now the FALLBACK source.
CREATE TABLE IF NOT EXISTS lyrics (
  video_id    TEXT NOT NULL,
  model       TEXT NOT NULL,             -- whisper model id ("base" / "small")
  lang        TEXT NOT NULL DEFAULT 'en',
  conf        REAL NOT NULL DEFAULT 0,    -- mean confidence 0..1 (0 = unknown)
  lines       TEXT NOT NULL,             -- JSON LyricsLine[] ({start,end,text})
  contributor TEXT,                       -- account id if signed in (nullable)
  created_at  INTEGER NOT NULL,           -- epoch ms
  PRIMARY KEY (video_id, model)
);
CREATE INDEX IF NOT EXISTS idx_lyrics_video ON lyrics(video_id);
