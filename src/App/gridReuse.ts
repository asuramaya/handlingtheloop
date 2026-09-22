// MAY WE TRUST A POOLED BEATGRID FOR THE AUDIO WE ACTUALLY DECODED?
//
// The cache-first load reuses a beatgrid from the shared `track_analysis` dataset instead of
// re-running the detector. That is a real saving and the right default — a grid is a fact about a
// recording and deriving it again produces the same answer. The gate for it asked one question:
// is the stored `version` at least ours. Which is a question about the ALGORITHM, and the algorithm
// was never the doubtful part.
//
// ★ WHAT WAS NEVER CHECKED IS WHETHER THE GRID DESCRIBES THIS AUDIO. `firstBeat` is an ABSOLUTE
// time in seconds, and `analyzeTrack` takes a supplied grid verbatim. So if the bytes this device
// downloaded for a videoId differ from the bytes the contributing device analysed — a different
// leading offset, a re-upload, a different served rendition — every beat in the track is displaced
// by that difference, permanently, and re-analysing does not fix it because re-analysing is exactly
// what the reuse skips. src/htl/analysis/gridReuse.test.ts measures the consequence: 250 ms of
// offset is half a beat of error at 120 bpm, which is as wrong as a beatgrid can be, and 30 ms is
// 6% of a beat on every beat of the track with nothing absorbing it.
//
// ★ THIS IS A GUARD, NOT A FIX FOR A CONFIRMED DEFECT, and the distinction is worth keeping: that
// the served audio for one videoId actually DOES vary in production is unmeasured. The local D1
// cannot answer it (every row here was written by this machine, so it agrees with itself by
// construction — the wrong population). What makes it worth writing anyway is the cost asymmetry:
// a rejected grid falls back to deriving locally, which is simply the behaviour from before the
// cache existed, and the re-derive then re-contributes at our version WITH a duration, so a row
// that could not be checked becomes one that can. The guard is self-healing in the direction of
// more cache, not less.
//
// The stored duration is `Math.round(buffer.duration)` of a decoded buffer (App.tsx's contribution
// path), so this compares like with like — one decoded length against another — and the tolerance
// is for that rounding, not for the audio.

/** Seconds of disagreement tolerated between the stored grid's audio and ours. Both numbers come
 *  from a decoded buffer and the stored one is rounded to a whole second, so a real match can
 *  differ by up to 1 s; 2 is that plus a margin. Anything past it is a different recording, not a
 *  rounding — and the failure this exists to stop needs only a few hundred ms to be total. */
export const GRID_DURATION_TOLERANCE_S = 2;

export type GridReuseWhy = "fits" | "no-row" | "behind-version" | "unknown-duration" | "different-audio";

/** Whether a stored analysis row may supply this load's beatgrid. `why` is the witness — a load
 *  that silently declines to reuse and one that had nothing to reuse look identical otherwise. */
export function mayReuseGrid(
  stored: { version: number; duration: number | null } | null,
  decodedDurationS: number,
  ourVersion: number,
): { ok: boolean; why: GridReuseWhy } {
  if (!stored) return { ok: false, why: "no-row" };
  if (!(stored.version >= ourVersion)) return { ok: false, why: "behind-version" };
  // A row carrying no duration is the case this guard exists for: we cannot tell whether its grid
  // describes our audio. Deriving locally costs one analysis pass and re-contributes a row that
  // CAN be checked next time, so declining converges the pool rather than permanently refusing it.
  if (stored.duration == null || !Number.isFinite(stored.duration)) return { ok: false, why: "unknown-duration" };
  if (!Number.isFinite(decodedDurationS) || decodedDurationS <= 0) return { ok: false, why: "unknown-duration" };
  if (Math.abs(stored.duration - decodedDurationS) > GRID_DURATION_TOLERANCE_S) return { ok: false, why: "different-audio" };
  return { ok: true, why: "fits" };
}
