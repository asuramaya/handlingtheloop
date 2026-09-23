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
// The stored duration is a decoded buffer's own length (App.tsx's contribution path), so this
// compares like with like — one decoded length against another.

// ★ THE TOLERANCE WAS AN ORDER OF MAGNITUDE LARGER THAN THE FAILURE, and the guard's own comment
// said so without either of us noticing: "the failure this exists to stop needs only a few hundred
// ms to be total", above a tolerance of 2 SECONDS. A re-upload with a 250 ms leading offset shifts
// the duration by 250 ms, sails through a 2 s gate, and displaces every beat by half a beat at
// 120 bpm. The guard could not catch the case it was written for, for any offset under two seconds
// — which is the entire realistic range.
//
// The 2 s was never about the audio. It was about the WRITE rounding to a whole second
// (Math.round(buffer.duration)), so a genuine match could differ by up to 1 s and the gate had to
// admit that. Fixing the write fixes the gate: contributions carry millisecond precision now, and a
// row that HAS that precision is held to a tight tolerance.
//
// Legacy rows are told apart by the rounding itself — a stored integer is a pre-fix row (or a track
// whose length happens to be exact, which only costs it a looser gate). No migration, no column, no
// cutover: the pool converges as tracks are re-contributed, the same lazy shape as the version gate.

/** Tolerated disagreement for a LEGACY row, whose duration was rounded to a whole second on write:
 *  a real match can differ by up to 1 s, and 2 is that plus a margin. This is the old behaviour,
 *  kept only for rows that cannot support better. */
export const GRID_DURATION_TOLERANCE_S = 2;

/** Tolerated disagreement for a row written with millisecond precision. Decoders differ slightly on
 *  the same bytes (priming samples, resampling), so this is not zero — but it is far below the
 *  ~250 ms that makes a grid as wrong as a grid can be, which is the number that has to bound it.
 *  A false rejection costs one local analysis pass and re-contributes a precise row, so the
 *  asymmetry points at tight. */
export const GRID_DURATION_TOLERANCE_PRECISE_S = 0.1;

/** Which tolerance applies to this stored duration. An integer is a rounded (legacy) write. */
export function toleranceFor(storedDuration: number): number {
  return Number.isInteger(storedDuration) ? GRID_DURATION_TOLERANCE_S : GRID_DURATION_TOLERANCE_PRECISE_S;
}

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
  if (Math.abs(stored.duration - decodedDurationS) > toleranceFor(stored.duration)) return { ok: false, why: "different-audio" };
  return { ok: true, why: "fits" };
}

// ★ AND THE OTHER HALF OF THE CONTRACT, WHICH THE GUARD ABOVE CREATED THE NEED FOR.
//
// mayReuseGrid protects the READER: a device whose audio disagrees with the pooled row derives its
// own grid instead of adopting a wrong one. Nothing protected the WRITER. The contribution path then
// posts that locally-derived grid under the same videoId at the same ANALYSIS_VERSION, and
// putAnalysis overwrites on `excluded.version >= track_analysis.version` — verified against the
// production SQL on a real D1: same version, different duration, and the row flips wholesale, grid
// and all.
//
// So two devices holding different audio for one videoId OSCILLATE. A reads the row, rejects it,
// derives, overwrites with its own. B reads the row, rejects it, derives, overwrites back. Neither
// ever gets a cache hit, every load pays a full re-derive, and every load writes to D1 — silently,
// with nothing anywhere reporting that this videoId is contested.
//
// A device that refused the pool for `different-audio` has NO evidence its own audio is the more
// canonical one. Overwriting is not a repair, it is a move in a game the other device will answer.
// Declining leaves a stable state where one side gets the cache instead of neither, which is
// strictly better than the trade it gives up.
//
// The other refusals must still contribute, and `behind-version` especially: that is exactly how the
// pool upgrades itself when ANALYSIS_VERSION moves, and suppressing it would break the lazy
// migration that makes re-versioning cheap (docs/analysis-reversioning.md).
//
// The real fix is that a videoId whose audio varies is not one key — the grid wants to be keyed by
// the AUDIO. That is a schema change, so it is named here and not taken.

/** Whether a load that ended up deriving its own grid should contribute it back to the pool. */
export function mayContributeAnalysis(why: GridReuseWhy): boolean {
  return why !== "different-audio";
}
