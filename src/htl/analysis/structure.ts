// Music structure analysis — Phase 2 (variable-length section boundaries via a chroma
// self-similarity matrix + Foote checkerboard novelty) and Phase 3 (repeat-section labelling,
// A/B/C/D reusing a letter for a repeated section, same as rekordbox's phrase view).
//
// Pure, feature-vector-in / boundaries-and-labels-out — no audio, no FFT, no Beatgrid. beats.ts
// supplies bar-synchronous feature vectors (it already frames + FFTs the track for onset
// detection; chroma rides the SAME per-frame magnitude spectrum for free — see onsetEnvelope).
// Kept pure and separate so the actual segmentation MATH is unit-testable on synthetic feature
// sequences without needing a real audio fixture — the same shape as sampleBands/debrick/piTrim.
//
// Why this replaces the old single-period comb fit (detectPhrases): that approach could only
// ever output ONE uniform bar period (8, 16, or 32) for the whole track, so it structurally could
// not match rekordbox-style variable-length lettered sections (A/B/C/D...). A self-similarity
// matrix + checkerboard novelty (Foote, "Automatic Audio Segmentation Using a Measure of Audio
// Novelty", 2000) finds boundaries wherever the music's CONTENT actually changes — any length,
// any count — and the same matrix, block-averaged between boundaries, is what Phase 3 clusters
// to assign repeat labels.

/** Dot product of two equal-length vectors. Callers pass L2-NORMALIZED feature vectors, so this
 *  IS cosine similarity (no separate norm division needed here, and no need to store norms). */
function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/** L2-normalize `v` in place; a near-zero vector (silence) is left at zero rather than blown up
 *  by dividing by ~0 — a silent bar then reads as maximally DISSIMILAR to everything (correct:
 *  a zero vector's dot product with anything is 0), not a noise-amplified false match. */
export function l2normalize(v: Float32Array): Float32Array {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  const n = Math.sqrt(s);
  if (n > 1e-9) for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

/** Self-similarity matrix: ssm[i*n+j] = cosine similarity of vectors[i] and vectors[j], flat
 *  row-major N×N (N = vectors.length). Symmetric, diagonal = 1 (a bar is identical to itself). */
export function buildSSM(vectors: Float32Array[]): Float32Array {
  const n = vectors.length;
  const ssm = new Float32Array(n * n);
  for (let i = 0; i < n; i++) {
    ssm[i * n + i] = 1;
    for (let j = i + 1; j < n; j++) {
      const s = dot(vectors[i], vectors[j]);
      ssm[i * n + j] = s;
      ssm[j * n + i] = s;
    }
  }
  return ssm;
}

// Foote's checkerboard kernel at radius L (bars): a 2L×2L block, +1 where the two offsets share
// a sign (both "before" the centre or both "after" — self-similar quadrants), −1 where they
// don't (cross quadrant — where a boundary shows up as a content mismatch), tapered by a radial
// Gaussian so the sharp block edges don't ring the novelty curve.
function checkerboardKernel(L: number): Float32Array {
  const size = 2 * L;
  const k = new Float32Array(size * size);
  const sigma = L / 2;
  for (let i = 0; i < size; i++) {
    const di = i - L + 0.5;
    for (let j = 0; j < size; j++) {
      const dj = j - L + 0.5;
      const sign = Math.sign(di) * Math.sign(dj);
      const gauss = Math.exp(-(di * di + dj * dj) / (2 * sigma * sigma));
      k[i * size + j] = sign * gauss;
    }
  }
  return k;
}

/** Checkerboard novelty at ONE radius L (bars): high where the SSM neighbourhood around bar `b`
 *  looks like two dissimilar blocks meeting — a section change. O(n·L²), trivial at bar
 *  resolution (n ~ a few hundred, L ~ single digits to a few dozen). Edge bars (within L of
 *  either end, where the kernel would run off the matrix) are left at 0. */
export function checkerboardNovelty(ssm: Float32Array, n: number, L: number): Float32Array {
  const novelty = new Float32Array(n);
  if (L < 1 || n < 2 * L + 1) return novelty;
  const kernel = checkerboardKernel(L);
  const size = 2 * L;
  for (let b = L; b < n - L; b++) {
    let s = 0;
    const base = b - L;
    for (let i = 0; i < size; i++) {
      const row = (base + i) * n;
      for (let j = 0; j < size; j++) s += ssm[row + base + j] * kernel[i * size + j];
    }
    novelty[b] = s;
  }
  return novelty;
}

/** Multi-scale novelty: run checkerboardNovelty at several radii (DJ phrases run anywhere from a
 *  few bars to 32) and combine by taking the max at each bar, each scale first normalised to its
 *  OWN peak so a short-radius scale (naturally smaller absolute values — smaller kernel, less
 *  summed contrast) isn't just drowned out by a long one. A boundary that's only strong at one
 *  scale (a short fill vs. a whole-section change) still shows up. */
export function multiScaleNovelty(ssm: Float32Array, n: number, radii: number[]): Float32Array {
  const combined = new Float32Array(n);
  for (const L of radii) {
    const nov = checkerboardNovelty(ssm, n, L);
    let peak = 1e-9;
    for (let b = 0; b < n; b++) if (nov[b] > peak) peak = nov[b];
    for (let b = 0; b < n; b++) combined[b] = Math.max(combined[b], nov[b] / peak);
  }
  return combined;
}

/** Peak-pick section boundaries from a novelty curve: local maxima above a ROBUST adaptive
 *  threshold (median + 1.5·MAD — scale-free, doesn't need per-track tuning the way a fixed
 *  constant would), enforcing a minimum spacing so one transition doesn't double-fire into two
 *  adjacent boundaries. Always includes bar 0 (the track always "starts a section"). Returns bar
 *  indices, ascending. */
export function pickBoundaries(novelty: Float32Array, n: number, minSpacing: number): number[] {
  if (n <= 0) return [0];
  const sorted = Float32Array.from(novelty.subarray(0, n)).sort();
  const median = sorted[sorted.length >> 1] ?? 0;
  let madSum = 0;
  for (let b = 0; b < n; b++) madSum += Math.abs(novelty[b] - median);
  const mad = n ? madSum / n : 0;
  const thresh = median + 1.5 * mad;
  const candidates: { b: number; score: number }[] = [];
  for (let b = 1; b < n - 1; b++) {
    if (novelty[b] > thresh && novelty[b] >= novelty[b - 1] && novelty[b] >= novelty[b + 1]) {
      candidates.push({ b, score: novelty[b] });
    }
  }
  candidates.sort((a, c) => c.score - a.score); // strongest first, so it wins a spacing conflict
  const chosen: number[] = [0];
  for (const c of candidates) {
    if (chosen.every((x) => Math.abs(x - c.b) >= minSpacing)) chosen.push(c.b);
  }
  chosen.sort((a, c) => a - c);
  return chosen;
}

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** Phase 3: label each boundary-delimited segment so a REPEATED section (chorus, drop…) reuses
 *  the SAME letter, in order of first appearance — A is whatever's heard first, B the first new
 *  thing after that, and a later segment similar enough to an earlier one inherits its letter
 *  instead of minting a new one. Reuses the SAME bar-level SSM boundaries came from (no new
 *  features/extraction — a segment's similarity to another is just its block of that matrix,
 *  averaged) via block-averaging into an N_segments×N_segments matrix.
 *
 *  Greedy + order-of-appearance, not global clustering: a DJ (and rekordbox) reads structure
 *  forward through the track, so "first heard = defines the letter, later repeats inherit it" is
 *  the behaviour that actually matches the reference, not a globally-optimal but order-blind
 *  clustering that could relabel an early section after seeing a later, more "central" one.
 *
 *  `boundaries` are bar indices (ascending, as from pickBoundaries); `n` is the SSM's bar count.
 *  The match threshold is a PERCENTILE of this track's own non-adjacent segment-pair similarities
 *  (not a fixed constant — absolute similarity varies hugely by genre/production, same reasoning
 *  as the adaptive threshold in pickBoundaries). Adjacent segments never merge — that would mean
 *  the boundary itself was spurious, a Phase 2 concern, not a labelling one. `maxLetters` caps
 *  how many distinct letters a very long, near-endless track can mint before new segments are
 *  forced onto their nearest existing cluster instead of spawning yet another one. */
export function labelSegments(ssm: Float32Array, n: number, boundaries: number[], maxLetters = 8): string[] {
  const segs = boundaries.length;
  if (segs === 0) return [];
  const ends = boundaries.slice(1).concat([n]);

  // Block-average similarity between every pair of segments, straight off the bar-level SSM.
  const segSim = new Float32Array(segs * segs);
  for (let i = 0; i < segs; i++) {
    for (let j = i; j < segs; j++) {
      let sum = 0;
      let cnt = 0;
      for (let bi = boundaries[i]; bi < ends[i]; bi++) {
        const row = bi * n;
        for (let bj = boundaries[j]; bj < ends[j]; bj++) {
          sum += ssm[row + bj];
          cnt++;
        }
      }
      const v = cnt ? sum / cnt : 0;
      segSim[i * segs + j] = v;
      segSim[j * segs + i] = v;
    }
  }

  // Adaptive match threshold from this track's own NON-ADJACENT segment-pair similarities,
  // floored by an ABSOLUTE match bar. Picked from the DEDUPED, rounded distribution rather than
  // the raw percentile rank: a percentile of the raw array can land EXACTLY on one of the very
  // values being compared against it (a real repeat pair's own score, or — with zero real
  // structure — every pair tied at the same baseline), so a straight `>=`/`>` against that exact
  // value is a coin flip on floating-point jitter either way. Rounding to dedupe near-ties, then
  // splitting the gap BETWEEN two distinct clusters of values, gives a threshold that actually
  // sits between "these are the same section" and "these aren't" instead of on top of one of
  // them — but that only works when there are ENOUGH non-adjacent pairs to form a real
  // distribution. A short track (segs=3 has exactly ONE non-adjacent pair: 0-vs-2) has nothing
  // to build a percentile FROM — `uniq.length` is 0 or 1 either way, whether that lone pair is a
  // perfect match or a total mismatch, so a percentile-only threshold can't tell those apart and
  // (confirmed via a real A-B-A synthetic track: boundaries landed exactly right, but the third
  // segment came back a fresh "C" instead of reusing "A" despite scoring a PERFECT 1.0 against
  // it) defaulting to "never merge" there is a straight false negative, not caution. The absolute
  // floor is what actually judges a lone pair (or any pair, even in a rich distribution): a
  // cosine similarity this high on real musical chroma IS the same section on its own merits,
  // full stop, regardless of how many other segments exist to rank it against. The adaptive
  // percentile still applies its own (potentially higher/stricter) bar on top when there's
  // enough data to trust one — Math.max keeps whichever is more conservative.
  const ABSOLUTE_MATCH_FLOOR = 0.75;
  const vals: number[] = [];
  for (let i = 0; i < segs; i++) for (let j = i + 2; j < segs; j++) vals.push(segSim[i * segs + j]);
  const uniq = Array.from(new Set(vals.map((v) => Math.round(v * 1e4) / 1e4))).sort((a, b) => a - b);
  let thresh = ABSOLUTE_MATCH_FLOOR;
  if (uniq.length > 1) {
    const idx = Math.max(1, Math.floor(uniq.length * 0.75));
    thresh = Math.max(thresh, (uniq[idx - 1] + uniq[idx]) / 2);
  }

  const clusterRep: number[] = []; // first-occurrence segment index of each cluster, index = letter
  const labels: string[] = [];
  for (let i = 0; i < segs; i++) {
    let bestC = -1;
    let bestScore = -Infinity;
    for (let c = 0; c < clusterRep.length; c++) {
      if (i - clusterRep[c] < 2) continue; // never merge with the immediately preceding segment
      const s = segSim[i * segs + clusterRep[c]];
      if (s > bestScore) {
        bestScore = s;
        bestC = c;
      }
    }
    if (bestC >= 0 && bestScore >= thresh) {
      labels.push(LETTERS[bestC % LETTERS.length]);
    } else if (clusterRep.length < maxLetters) {
      clusterRep.push(i);
      labels.push(LETTERS[clusterRep.length - 1]);
    } else {
      // Letter cap hit: forced onto the nearest existing cluster regardless of threshold, rather
      // than minting a 9th+ letter no DJ workflow expects.
      labels.push(LETTERS[bestC >= 0 ? bestC % LETTERS.length : 0]);
    }
  }
  return labels;
}
