import type { CaptionCue } from "@htl/media";

// Where the lyrics on a deck's ribbon came from.
//   lrclib  = ground-truth words + LRCLIB's own LINE clock. No stem, no model, no GPU — works on a
//             phone, and is already a usable feature on its own.
//   aligned = those same words, with every WORD placed on a real onset measured from THIS device's
//             isolated vocal stem. The upgrade, not the prerequisite.
//   pool    = someone else's device already did the alignment; we took theirs.
//   youtube = the last-resort fallback when LRCLIB has never heard of the track.
export type LyricsSource = "lrclib" | "aligned" | "pool" | "youtube";

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
  lang: string; // language: "und" (undetermined) unless a decoder actually reports one
  source: LyricsSource;
  conf: number; // mean confidence 0..1; 0 = unknown (v1 leaves it 0)
  ver?: number; // transcript-FORMAT version (LYRICS_VER) that produced these lines — drives the
  // pool's reuse-vs-recompute gate; absent on a pre-0026 row, which means "oldest" (1).
  lines: LyricsLine[];
  createdAt: number; // epoch ms
}

// ---- diagnostics -----------------------------------------------------------------------
// The instrument for "are the lyrics even firing, and if not, WHERE did it stop?". Each field
// answers one link in the chain, in order, so a blank one names the exact step that failed.
export interface LyricsDiag {
  source: LyricsSource;
  artist: string | null; // canonical, from the acoustic fingerprint (null = never identified)
  title: string | null;
  matched: boolean; // LRCLIB had this recording
  instrumental: boolean; // ...and says it has no vocals. A free, CORRECT "no lyrics".
  lines: number;
  words: number;
  onsets: number; // vocal transients measured in the isolated stem — the timing EVIDENCE
  offset: number; // whole-track shift removed, seconds (the LRC was timed against another edit)
  confidence: number; // share of lines that landed on real singing at that offset, 0..1
  bias: number; // residual constant lag the DP removed, seconds
  drift: number; // residual linear drift removed, s/s
  snapped: number; // words placed on a real vocal onset
  free: number; // words with no onset to sit on (a held vowel genuinely has none)
  applied: boolean; // false = the input was too thin to align; times passed through untouched
  ms: number;
}

// Lines render through the existing caption ribbon unchanged.
export function toCues(t: { lines: LyricsLine[] }): CaptionCue[] {
  return t.lines.map((l) => ({ start: l.start, end: l.end, text: l.text }));
}
