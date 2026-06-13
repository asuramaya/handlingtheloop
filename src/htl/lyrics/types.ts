import type { CaptionCue } from "@htl/media";

// Where the lyrics on a deck's ribbon came from. whisper = decoded on THIS device from the
// vocal stem; pool = downloaded from the shared community transcript cache (same Whisper
// output, just someone else's GPU); youtube = the fallback timed-text captions.
export type LyricsSource = "whisper" | "pool" | "youtube";

// One line of a transcript — start/end in TRACK-seconds, like a CaptionCue, so it still
// renders through the caption ribbon. `words` carries per-WORD start times (Whisper word-
// level timestamps) so the ribbon can light the exact word being sung; absent for the
// YouTube fallback (segment-only), which then highlights the whole line.
export interface LyricsWord {
  t: number; // word start, seconds (track time)
  w: string; // the word
  d?: number; // duration, seconds — how long the word is held (so a sustained word reads long)
}
export interface LyricsLine {
  start: number;
  end: number;
  text: string;
  words?: LyricsWord[];
}

// The full transcript for a track — the unit stored in IndexedDB and shared in the D1
// community pool, so phones (which can't run the model) and repeat plays get accurate,
// track-timed lyrics instantly.
export interface LyricsTranscript {
  v: 1; // schema version
  videoId: string;
  model: string; // whisper model id it was decoded with (see WHISPER_MODELS)
  lang: string; // detected / forced language (e.g. "en")
  source: LyricsSource;
  conf: number; // mean confidence 0..1; 0 = unknown (v1 leaves it 0)
  lines: LyricsLine[];
  createdAt: number; // epoch ms
}

// Lines render through the existing caption ribbon unchanged.
export function toCues(t: { lines: LyricsLine[] }): CaptionCue[] {
  return t.lines.map((l) => ({ start: l.start, end: l.end, text: l.text }));
}
