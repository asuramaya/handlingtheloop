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
  lang: string; // language: "und" (undetermined) unless a decoder actually reports one
  source: LyricsSource;
  conf: number; // mean confidence 0..1; 0 = unknown (v1 leaves it 0)
  ver?: number; // transcript-FORMAT version (LYRICS_VER) that produced these lines — drives the
  // pool's reuse-vs-recompute gate; absent on a pre-0026 row, which means "oldest" (1).
  lines: LyricsLine[];
  createdAt: number; // epoch ms
}

// ---- alignment diagnostics -------------------------------------------------------------
// The instrument for "why don't the lyrics line up?". We have something most transcription
// pipelines don't: a CLEAN isolated vocal stem, so the REAL vocal onsets are recoverable with
// confidence. Comparing Whisper's word times against those onsets tells us WHICH kind of wrong
// we are, and the three kinds have completely different fixes:
//
//   medianLag ≈ 0, small spread  → alignment is fine; the bug is elsewhere (render/time-base).
//   medianLag = a constant       → a PIPELINE OFFSET (ours). Exactly fixable: shift by it.
//   driftMsPerMin large          → a RATE / CHUNK-OFFSET bug (ours). Exactly fixable.
//   medianLag ≈ 0, HUGE spread   → the MODEL is guessing per word. No offset can fix it;
//                                  needs real forced alignment or a better model.
//
// Measured over a WIDE (±2 s) search window ON PURPOSE: the shipped snap only looks ±160 ms, so
// it would clip — and hide — exactly the error we're hunting.
export interface LyricsDiag {
  mode: "word" | "segment"; // did word-level timestamps engage, or did we fall back?
  wordError?: string; // why word mode was abandoned (the fallback used to be silent)
  model: string; // repo actually loaded
  dtype: string; // what the GPU actually ran (q4, or the fp32 fallback)
  tjs?: string; // transformers.js version that produced this (word timestamps have had real bugs)
  lines: number;
  words: number;
  onsets: number; // vocal transients detected in the stem
  matched: number; // words with ANY onset inside the wide search window
  medianLag: number; // seconds, signed: onset − whisperWordTime. THE headline number.
  madLag: number; // median absolute deviation — systematic (small) vs random (large)
  driftMsPerMin: number; // slope of lag over time — a rate/chunk bug shows up here
  within160: number; // fraction of words the OLD ±160 ms snap could even reach (0..1)
  decodeMs: number;
  // What the forced aligner DID about it (see align.ts). Reported, never used to grade itself:
  // it snaps words to onsets, so "distance to the nearest onset" afterwards is ~0 by construction
  // and would be an instrument pointed at the part we're proud of. The ear is the acceptance test.
  align?: {
    bias: number; // constant lag removed, seconds
    drift: number; // linear drift removed, seconds per second
    snapped: number; // words placed on a real vocal onset
    free: number; // words left on the model's corrected time (held vowels, legato)
    medianMove: number; // median distance a word actually moved, seconds
    applied: boolean; // false = it declined to act (too little to go on, or it couldn't justify it)
  };
}

// Lines render through the existing caption ribbon unchanged.
export function toCues(t: { lines: LyricsLine[] }): CaptionCue[] {
  return t.lines.map((l) => ({ start: l.start, end: l.end, text: l.text }));
}
