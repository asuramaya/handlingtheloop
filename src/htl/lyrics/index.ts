// Whisper-on-vocal-stem lyric transcription, pooled in the community cache and falling
// back to YouTube captions. See client.ts for the resolver, models.ts for the picker.
export * from "./types";
export * from "./models";
export * from "./client";
// The pool's reuse-vs-recompute + don't-publish-garbage rules, pure and tested. Exported so any
// future surface uses THE gate rather than reimplementing a second, subtly different one.
export { planLyrics, looksDegenerate, type LyricsPlan } from "./convergence";
// The alignment measurement + how to read it — see formatLyricsDiag for what each number MEANS.
export { formatLyricsDiag, lyricsVerdict } from "./diag";
// The forced aligner — Whisper gives the words, the vocal stem gives the times.
export { alignWords, estimateBias, globalLag, nearestOnset, type AlignReport, type AlignOpts } from "./align";
