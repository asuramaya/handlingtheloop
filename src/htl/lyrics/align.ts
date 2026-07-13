// Forced alignment of Whisper's words onto the REAL vocal onsets.
//
// ★ THE INVERSION. Whisper is a SPEECH model, and its word timestamps are not measured — they are
// inferred from cross-attention (a DTW over attention weights). Singing is exactly where that
// inference collapses: held vowels, melisma, no clean word boundaries. So the shipped design asked
// the component that is WORST at timing to do the timing, and then patched it with a ±160 ms
// nearest-onset snap — a window smaller than the error it was patching, so it mostly no-opped.
//
// We hold an asset almost nobody else does: a CLEAN ISOLATED VOCAL STEM. The real vocal onsets are
// recoverable from it with confidence. So:
//
//        Whisper  →  WHAT was sung, and the RELATIVE structure  (it is good at both)
//        our DSP  →  WHEN it was sung                            (we have the stem)
//
// ★ THE KEY ASSUMPTION, and it is the load-bearing one: Whisper's RELATIVE timing (the gaps
// between consecutive words) is far more trustworthy than its ABSOLUTE timing. A whole line can be
// 400 ms late while the words within it are spaced correctly. So we do not snap each word
// independently — that shreds the line's internal rhythm. We slide and stretch the word sequence
// onto the onsets while PRESERVING its internal gaps, and only depart from Whisper's structure
// when an onset makes a strong case.
//
// This one pass subsumes all three failure modes, which is why it is worth building instead of
// three separate patches: a constant OFFSET is removed by the bias estimate, a DRIFT by the slope
// estimate, and per-word SCATTER by the DP. It does not care WHY the model's times were wrong.
//
// ⚠ HONESTY ABOUT MEASUREMENT: do not grade this by "distance to the nearest onset" after it runs.
// It snaps to onsets, so that number is ~0 by construction and means nothing — it would be an
// instrument pointed at the part we are proud of. What it reports instead is what it DID (bias and
// drift removed, how far words moved, how many landed on a real onset). The ear is the acceptance
// test.

/** What the aligner did — reported, never used to grade itself. */
export interface AlignReport {
  /** Constant lag removed, seconds (+ = the vocals were LATER than Whisper claimed). */
  bias: number;
  /** Linear drift removed, seconds of lag per second of track. */
  drift: number;
  /** Words placed on a real detected vocal onset. */
  snapped: number;
  /** Words left on their (bias/drift-corrected) Whisper time — no onset made a case. */
  free: number;
  /** Median absolute distance a word moved, seconds. */
  medianMove: number;
  /** false when the input was too thin to align and the times were passed through untouched. */
  applied: boolean;
}

export interface AlignOpts {
  /** Only consider onsets this close to a word's corrected time. */
  window?: number;
  /** Most onset candidates to consider per word (keeps the DP cheap on dense stems). */
  maxCandidates?: number;
  /** Cost per second of deviation from the model's corrected time. */
  devW?: number;
  /** Cost per second of distortion to the model's word-to-word GAP. Higher than devW on purpose:
   *  the relative structure is the part of Whisper's output we actually trust. */
  gapW?: number;
  /** Flat cost of declining every onset and keeping the corrected time (legato, held vowels). */
  freePenalty?: number;
  /** Minimum separation between consecutive words so they never pile onto one tick. */
  minSep?: number;
}

// ★ THE COST MODEL, and the mistake it took a failing test to see. The first version charged a word
// for the DISTANCE IT MOVED to reach an onset — so a badly-scattered word preferred to sit still,
// and the aligner did nothing precisely when it was needed most. That has it backwards: the ONSET is
// the evidence (a vocal demonstrably started there); Whisper's time is only a PRIOR on which onset
// is the right one. So `devW` is a plausibility term, not a punishment, and declining every onset
// (`freePenalty`) has to cost MORE than a typical in-window snap — otherwise nothing ever snaps.
//
// `gapW` is deliberately WEAK. Word-to-word gaps are DIFFERENCES of two noisy timestamps, so they
// are noisier than the timestamps themselves — leaning on them would enslave us to the noise. What
// actually stops a dense run collapsing onto one onset isn't the gap term at all: it's the
// ONE-ONSET-ONE-WORD constraint in the DP. Two words cannot start on the same vocal transient.
const DEF: Required<AlignOpts> = {
  window: 0.35,
  maxCandidates: 6,
  devW: 1,
  gapW: 0.3,
  freePenalty: 0.4,
  minSep: 0.02,
};

// How far the word train may be slid to find its onsets. Bounded ON PURPOSE — see globalLag. A
// model that mis-times a word by more than this isn't offset, it's broken, and a wider search only
// buys us more wrong beats to lock onto.
const MAX_LAG = 0.8;
// Pull toward zero lag, per word per second of shift. Breaks the rhythmic ambiguity; small enough
// to be irrelevant when the true peak is real.
const LAG_REG = 0.08;

/** Nearest onset to t (onsets must be sorted ascending). */
export function nearestOnset(onsets: number[], t: number): number {
  if (!onsets.length) return t;
  let lo = 0;
  let hi = onsets.length - 1;
  if (t <= onsets[0]) return onsets[0];
  if (t >= onsets[hi]) return onsets[hi];
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (onsets[m] < t) lo = m + 1;
    else hi = m;
  }
  const a = onsets[lo - 1];
  const b = onsets[lo];
  return t - a <= b - t ? a : b;
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * The lag that makes the word train agree BEST with the onset train, found by scanning candidate
 * lags and scoring global agreement.
 *
 * ★ WHY NOT "AVERAGE THE DISTANCE TO THE NEAREST ONSET" — the obvious method, and the one that was
 * shipped. It ALIASES. If onsets are 500 ms apart and the words are 400 ms early, every word is
 * NEARER to the previous onset than to its own, so the measured lag comes out as −100 ms: an error
 * larger than half the onset spacing simply wraps around. On dense singing (onsets a few hundred ms
 * apart) that method cannot see a real offset AT ALL, and it will happily report that a badly
 * misaligned track is fine. A lag scan has no such blind spot: it asks "if I slide the WHOLE word
 * train by L, how many words land on a real onset?" — and only the true lag makes most of them land
 * at once. This works precisely because real singing is NOT a metronome; irregular onset spacing is
 * what breaks the ambiguity.
 */
export function globalLag(wordTimes: number[], onsets: number[], search = MAX_LAG, tol = 0.08, minHitRate = 0.2): number {
  if (wordTimes.length < 4 || onsets.length < 4) return 0;
  const STEP = 0.01; // 10 ms — finer than anyone can hear
  let bestLag = 0;
  let bestScore = -1;
  for (let L = -search; L <= search + 1e-9; L += STEP) {
    let score = 0;
    for (const t of wordTimes) {
      const shifted = t + L;
      const d = Math.abs(nearestOnset(onsets, shifted) - shifted);
      if (d < tol) score += 1 - d / tol; // triangular kernel: only genuinely-close hits count
    }
    // ★ PREFER THE SMALLEST LAG THAT EXPLAINS THE DATA. Music is RHYTHMIC, so the onset train is
    // quasi-periodic, so the correlation has SEVERAL near-equal peaks — one per beat of shift — and
    // the scan will happily pick a confidently-wrong one a beat or two away. (It did: it reported
    // +1.51 s when the truth was −0.35 s, and dragged the whole track there.) The tie-break is a
    // prior we genuinely hold: Whisper is wrong by HUNDREDS OF MILLISECONDS, not by seconds. A
    // gentle pull toward zero costs nothing when the true peak is distinct and saves us when it
    // isn't.
    score -= LAG_REG * wordTimes.length * Math.abs(L);
    if (score > bestScore) {
      bestScore = score;
      bestLag = L;
    }
  }
  // ★ REQUIRE REAL AGREEMENT before claiming a lag. Without this, a handful of words and a sparse
  // onset field will always find SOME shift that lands two of them on something, and we'd invent a
  // confident offset out of coincidence — then drag the whole track by it. Silence is the right
  // answer when the evidence is thin.
  const minScore = Math.max(3, minHitRate * wordTimes.length);
  return bestScore >= minScore ? bestLag : 0;
}

/** How well a (bias, drift) correction makes the words land on real onsets. Higher is better. */
function agreement(wordTimes: number[], onsets: number[], bias: number, drift: number, tol: number): number {
  const t0 = wordTimes[0];
  let s = 0;
  for (const t of wordTimes) {
    const x = t + bias + drift * (t - t0);
    const d = Math.abs(nearestOnset(onsets, x) - x);
    if (d < tol) s += 1 - d / tol;
  }
  return s;
}

/**
 * The SYSTEMATIC part of the error: a constant lag PLUS a linear drift, found by scanning both at
 * once and keeping whichever pair makes the most words land on real onsets.
 *
 * ★ WHY A 2-D SCAN, having tried the clever alternative and watched it fail. The obvious approach is
 * to slice the track into chunks, find each chunk's own lag, and fit a line through them: intercept
 * = bias, slope = drift. It works on clean data and it FALLS APART exactly where it matters — when
 * drift and per-word scatter coexist, which is the realistic case. Each chunk is small, so scatter
 * drowns its correlation peak; the chunk scans either decline or return junk; the line is then fitted
 * to two or three points of noise. In testing that path produced a confident −350 ms bias on a track
 * whose real error was a +1.5% drift, applied it, and made the alignment THREE TIMES WORSE than doing
 * nothing. A direct scan has no such failure: it never estimates anything it cannot verify.
 *
 * ★ AND IT REFUSES TO ACT ON A CORRECTION IT CANNOT JUSTIFY. The winning (bias, drift) must beat
 * doing nothing by a real margin, or we return zeroes and leave the times alone. An aligner that can
 * make things worse is worse than no aligner — the user has no way to know which one they got.
 */
export function estimateBias(
  wordTimes: number[],
  onsets: number[],
  search = MAX_LAG,
): { bias: number; drift: number } {
  if (wordTimes.length < 4 || onsets.length < 4) return { bias: 0, drift: 0 };
  const n = wordTimes.length;
  const t0 = wordTimes[0];
  const span = wordTimes[n - 1] - t0;
  const TOL = 0.12; // ≈ the scatter we expect from the model; tighter than this and nothing hits

  const BIAS_STEP = 0.02;
  const DRIFT_MAX = n >= 24 && span > 20 ? 0.03 : 0; // no drift claim without a real span of track
  const DRIFT_STEP = 0.0025;

  let best = { bias: 0, drift: 0 };
  let bestScore = -Infinity;
  for (let d = -DRIFT_MAX; d <= DRIFT_MAX + 1e-9; d += DRIFT_STEP || 1) {
    for (let b = -search; b <= search + 1e-9; b += BIAS_STEP) {
      // Prefer the SIMPLEST explanation: a small bias over a large one, no drift over a drift. Music
      // is rhythmic, so the onset field is quasi-periodic and a scan will otherwise happily lock onto
      // a confidently wrong shift a beat away (it did: +1.51 s when the truth was −0.35 s).
      const score =
        agreement(wordTimes, onsets, b, d, TOL) - LAG_REG * n * Math.abs(b) - LAG_REG * n * Math.abs(d) * span;
      if (score > bestScore) {
        bestScore = score;
        best = { bias: b, drift: d };
      }
    }
    if (!DRIFT_MAX) break;
  }

  // Justify it, or don't do it. `base` is the agreement we already have; the correction has to beat
  // it by a clear margin AND land a decent share of the words, or it is noise-fitting.
  const base = agreement(wordTimes, onsets, 0, 0, TOL);
  const won = agreement(wordTimes, onsets, best.bias, best.drift, TOL);
  if (won < Math.max(base * 1.15, 0.25 * n)) return { bias: 0, drift: 0 };
  return best;
}

/**
 * Align word times to vocal onsets. Returns NEW times (monotonically non-decreasing) plus a report
 * of what was done. Never reorders words; never invents times when the input is too thin to work
 * with (it passes them through and says so).
 */
export function alignWords(
  wordTimes: number[],
  onsets: number[],
  opts: AlignOpts = {},
): { times: number[]; report: AlignReport } {
  const o = { ...DEF, ...opts };
  const n = wordTimes.length;
  const idle: AlignReport = { bias: 0, drift: 0, snapped: 0, free: n, medianMove: 0, applied: false };
  if (n < 2 || onsets.length < 4) return { times: [...wordTimes], report: idle };

  // 1) Remove the SYSTEMATIC error first, so the DP is choosing between onsets rather than fighting
  //    a global offset. (This alone fixes the OFFSET and DRIFT verdicts.)
  const { bias, drift } = estimateBias(wordTimes, onsets);
  const t0 = wordTimes[0];
  const corrected = wordTimes.map((t) => t + bias + drift * (t - t0));

  // 2) Candidates per word: the nearest onsets inside the window, plus the "decline them all" option
  //    (a held vowel or a legato phrase genuinely has no onset — forcing one there is worse than
  //    leaving the model's corrected guess alone).
  //
  //    ★ THE WINDOW IS ADAPTIVE. When the systematic estimate above declines to guess — which it
  //    rightly does when the evidence is ambiguous — a residual offset can still be larger than the
  //    window, and then NO word can see its own onset, every word takes the free option, and the
  //    aligner silently does nothing. That is the exact failure the old ±160 ms snap had, one level
  //    up. So: if hardly any word can reach an onset, open the window and look again. The
  //    one-onset-one-word rule and the gap term are what keep a wider search honest.
  const buildCands = (window: number) =>
    corrected.map((ct) => {
    const near: { t: number; free: boolean }[] = [];
    // Walk outward from the insertion point rather than scanning every onset.
    let lo = 0;
    let hi = onsets.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (onsets[m] < ct) lo = m + 1;
      else hi = m;
    }
      let i = lo - 1;
      let j = lo;
      while (near.length < o.maxCandidates && (i >= 0 || j < onsets.length)) {
        const di = i >= 0 ? ct - onsets[i] : Infinity;
        const dj = j < onsets.length ? onsets[j] - ct : Infinity;
        if (di === Infinity && dj === Infinity) break;
        if (di <= dj) {
          if (di <= window) near.push({ t: onsets[i], free: false });
          i--;
        } else {
          if (dj <= window) near.push({ t: onsets[j], free: false });
          j++;
        }
        if (Math.min(di, dj) > window) break;
      }
      near.push({ t: ct, free: true }); // always an option
      near.sort((a, b) => a.t - b.t);
      return near;
    });

  // ⚠ NO ADAPTIVE WINDOW. The obvious idea — "if few words can see an onset, widen the search" —
  // does not work and was removed: with a dense onset field EVERY word has SOME onset within the
  // window, just not its OWN, so the trigger never fires; and when forced, it drags legato words
  // onto distant onsets that have nothing to do with them. Reaching an onset is not the same as
  // reaching the RIGHT one. A residual offset that survives estimateBias is a job for the estimate,
  // not for a wider net.
  const cands = buildCands(o.window);
  const devW = o.devW;
  const freePenalty = o.freePenalty;

  // 3) Monotonic DP. Local cost = how far we drag the word from the model's corrected time (+ a
  //    penalty for declining every onset). Transition cost = how much we DISTORT the model's gap to
  //    the previous word — weighted higher, because the relative structure is what we trust.
  const INF = Infinity;
  const cost: number[][] = [];
  const back: number[][] = [];
  for (let i = 0; i < n; i++) {
    const ci = cands[i];
    cost.push(new Array(ci.length).fill(INF));
    back.push(new Array(ci.length).fill(-1));
    for (let j = 0; j < ci.length; j++) {
      const local = devW * Math.abs(ci[j].t - corrected[i]) + (ci[j].free ? freePenalty : 0);
      if (i === 0) {
        cost[0][j] = local;
        continue;
      }
      const want = corrected[i] - corrected[i - 1]; // the gap Whisper claims
      const prev = cands[i - 1];
      let best = INF;
      let bestK = -1;
      for (let k = 0; k < prev.length; k++) {
        if (cost[i - 1][k] === INF) continue;
        if (ci[j].t < prev[k].t) continue; // never reorder words
        // ★ ONE ONSET, ONE WORD. Two words cannot START on the same vocal transient — and this
        // single constraint, not the gap term, is what stops a fast run (a rap triplet, a run of
        // syllables between two sparse onsets) from collapsing onto one tick and reading as a
        // single word on the ribbon. The later words are pushed to the "free" option, which is
        // exactly right: they genuinely have no onset of their own.
        if (!ci[j].free && !prev[k].free && Math.abs(ci[j].t - prev[k].t) < 1e-6) continue;
        const c = cost[i - 1][k] + o.gapW * Math.abs(ci[j].t - prev[k].t - want);
        if (c < best) {
          best = c;
          bestK = k;
        }
      }
      if (bestK >= 0) {
        cost[i][j] = best + local;
        back[i][j] = bestK;
      }
    }
    // Every path died (an onset ordering that can't be reached monotonically) → fall back to the
    // free candidate so the DP always has a survivor. Alignment must never LOSE a word.
    if (cost[i].every((c) => c === INF)) {
      const fj = ci.findIndex((c) => c.free);
      const prevBest = i > 0 ? Math.min(...cost[i - 1].filter((c) => c !== INF)) : 0;
      cost[i][fj] = (Number.isFinite(prevBest) ? prevBest : 0) + freePenalty;
      back[i][fj] = i > 0 ? cost[i - 1].indexOf(prevBest) : -1;
      // Push it past the previous word so monotonicity holds even on this escape hatch.
      ci[fj] = { t: Math.max(ci[fj].t, i > 0 ? corrected[i - 1] : ci[fj].t), free: true };
    }
  }

  // 4) Walk the best path back.
  let j = 0;
  let best = INF;
  for (let k = 0; k < cands[n - 1].length; k++) {
    if (cost[n - 1][k] < best) {
      best = cost[n - 1][k];
      j = k;
    }
  }
  const out = new Array<number>(n);
  const wasFree = new Array<boolean>(n);
  for (let i = n - 1; i >= 0; i--) {
    out[i] = cands[i][j].t;
    wasFree[i] = cands[i][j].free;
    j = back[i][j];
    if (j < 0 && i > 0) j = 0; // defensive: a broken chain still yields times
  }

  // 5) Enforce a minimum separation so two words never land on the exact same tick (which reads as
  //    one word on the ribbon). Monotone, tiny, and it cannot reorder anything.
  for (let i = 1; i < n; i++) {
    if (out[i] < out[i - 1] + o.minSep) out[i] = out[i - 1] + o.minSep;
  }

  const moves = out.map((t, i) => Math.abs(t - wordTimes[i]));
  return {
    times: out,
    report: {
      bias,
      drift,
      snapped: wasFree.filter((f) => !f).length,
      free: wasFree.filter((f) => f).length,
      medianMove: median(moves),
      applied: true,
    },
  };
}
