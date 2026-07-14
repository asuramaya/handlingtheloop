// Lyrics: the WORDS come from LRCLIB (a published fact), the TIMES from the isolated vocal stem
// (a measurement). No generative model — see analyze.worker.ts for what that replaced, and why.
export * from "./types";
export * from "./client";
// The words source + the LRC format, and the title/artist cleanup that makes a real library match.
export { fetchLrcLib, parseLrc, lrcToLines, cleanTitle, primaryArtist, type LrcLine, type LrcResult } from "./lrclib";
// The times: a whole-track offset from structure, then every word onto a real vocal onset.
export { alignLrc, syllables, seedLine, sungSpans, coarseOffset, spanCoverage, type LrcReport } from "./lrcAlign";
// The pool's reuse-vs-recompute rule, pure and tested — so no surface reimplements a second one.
export { planLyrics, type LyricsPlan } from "./convergence";
// What happened, link by link — the answer to "are the lyrics even firing?"
export { formatLyricsDiag, lyricsVerdict } from "./diag";
// The monotonic DP the alignment rides on (one onset, one word; may decline).
export { alignWords, estimateBias, globalLag, nearestOnset, type AlignReport, type AlignOpts } from "./align";
