// The TIMES. LRCLIB gives us the words and a rough line clock; the vocal stem gives us when they
// were actually sung.
//
// ★ THE PROBLEM THIS SOLVES, WHICH THE OLD ALIGNER COULD NOT. align.ts corrects a systematic error
// up to MAX_LAG = 0.8 s — the right bound when the times came from Whisper, which is wrong by
// hundreds of milliseconds. LRC times are wrong in a completely different way: they were authored
// against SOME rendering of the song, and the YouTube upload we're playing may open with five
// seconds of talking, or a label ident, or an extended intro. That's a whole-track offset of
// SECONDS, and no per-word search will ever find it — every word is equally lost.
//
// So the offset is found FIRST, from structure rather than from words: build a binary "someone is
// singing here" mask from the LRC line spans, build the same mask from the vocal stem's energy, and
// slide one against the other. This is robust in exactly the place a word-level search is hopeless —
// long instrumental breaks and verse/chorus structure make the correlation sharp, and no acoustic
// model is involved, so it works identically in Japanese, Korean or Spanish.
//
// Then, and only then, the fine work: seed each word inside its line proportional to SYLLABLE COUNT
// (a three-syllable word takes about three times as long as a one-syllable word — a weak prior, but
// an honest one), and hand the whole train to the DP in align.ts, which pulls each word onto a real
// vocal onset, refuses when there isn't one, and can never let two words share a transient.
//
// ★ WHY A LINE IS A GOOD WINDOW. The whole-track version of this problem was under-determined:
// N words, M onsets, and nothing anchoring them. A line is a ~3-second window with a KNOWN START and
// a known end. Inside it, "distribute these six words across these nine onsets, in order" is nearly
// forced. That anchoring is what LRCLIB actually buys us — not just the words.
import { alignWords, type AlignReport } from "./align";
import type { LyricsLine, LyricsWord } from "./types";

/** What the LRC alignment did. Reported, never used to grade itself — the ear is the test. */
export interface LrcReport extends AlignReport {
  /** Whole-track offset removed, seconds (+ = our audio is LATER than the LRC's clock). */
  offset: number;
  /** How strongly the LRC's singing-mask agreed with the vocal stem's at that offset, 0..1.
   *  Low = the LRC probably describes a different rendering of the song than the one we're playing. */
  confidence: number;
  /** Share of the track the vocal stem calls "voiced". ★ Near 1 = the separation is leaky (bleed) and
   *  the gate failed, so `confidence` is measuring an all-ones mask and means NOTHING. Reported so
   *  the metric can admit when it has stopped measuring. */
  voiced: number;
  lines: number;
  words: number;
}

/** Syllable count — a length PRIOR for a word, not a claim about pronunciation.
 *
 *  Deliberately crude: it seeds the DP, which then answers to the actual vocal onsets. Being wrong
 *  by one syllable moves a seed by a few tens of milliseconds and the onsets correct it. Latin
 *  scripts count vowel groups; CJK counts characters (a kana/hanzi/hangul block IS about a
 *  syllable), which is why this stays honest in the languages Whisper was worst at. */
export function syllables(word: string): number {
  const s = word.toLowerCase().replace(/[^a-zà-öø-ÿ']/g, "");
  if (!s) {
    // Non-Latin: one syllable per character block is a good approximation for CJK/Hangul.
    const cjk = word.replace(/[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu, "").length;
    return Math.max(1, cjk);
  }
  const groups = s.match(/[aeiouyà-öø-ÿ]+/g);
  let n = groups ? groups.length : 1;
  if (n > 1 && /e$/.test(s)) n--; // silent final "e" — "time" is one syllable, not two
  return Math.max(1, n);
}

/** Lay a line's words across its span, each getting time in proportion to its syllables. */
export function seedLine(text: string, start: number, end: number): LyricsWord[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const syl = words.map(syllables);
  const total = syl.reduce((a, b) => a + b, 0);
  const span = Math.max(0.25, end - start);
  const out: LyricsWord[] = [];
  let acc = 0;
  for (let i = 0; i < words.length; i++) {
    out.push({ t: start + (acc / total) * span, w: words[i], d: (syl[i] / total) * span });
    acc += syl[i];
  }
  return out;
}

/** A 0/1 mask over `frames` of `hop` seconds: 1 where the LRC says someone is singing. */
export function maskFromLines(lines: { start: number; end: number }[], frames: number, hop: number): Float32Array {
  const m = new Float32Array(frames);
  for (const l of lines) {
    const a = Math.max(0, Math.round(l.start / hop));
    const b = Math.min(frames, Math.round(l.end / hop));
    for (let i = a; i < b; i++) m[i] = 1;
  }
  return m;
}

/** Syllables a singer gets through in a second. A rough constant, and it only has to be rough — it
 *  decides how long a line is SUNG for, versus how long until the next line starts, which are very
 *  different numbers whenever there's an instrumental bar in between. */
const SYL_PER_SEC = 4;

/**
 * How long each line is actually SUNG.
 *
 * ★ AN LRC FILE TELLS YOU WHEN A LINE STARTS AND NOTHING ELSE. The naive reading — "a line lasts
 * until the next one" — is wrong in the most common case in music: the gap between two lines usually
 * contains a bar or two of instrumental. Take it literally and a four-word line gets smeared across
 * six seconds, every word seed lands a second or more late, no word can see its own onset, and the
 * aligner quietly does nothing. (It did exactly that, and the test caught it.)
 *
 * So: a line lasts as long as its SYLLABLES need, and no longer than the next line's start. That also
 * gives the mask below real structure — bursts with gaps between them, which is what makes the
 * correlation sharp, instead of one solid block from the first lyric to the last.
 */
export function sungSpans(lines: { start: number; text: string }[], duration: number): { start: number; end: number }[] {
  return lines.map((l, i) => {
    const syl = l.text.split(/\s+/).filter(Boolean).reduce((a, w) => a + syllables(w), 0);
    const nextStart = i + 1 < lines.length ? lines[i + 1].start : duration;
    const sung = Math.max(0.4, syl / SYL_PER_SEC);
    return { start: l.start, end: Math.min(nextStart, l.start + sung) };
  });
}

/**
 * ★ THE VOICED CLOCK — time with the silence taken out, and the monotone map back.
 *
 * This is the load-bearing idea, and it took Rammstein to see it. "Du Hast" has one LRC line —
 * "Du, du hast, du hast mich" — sung across ten seconds with two bars of guitar inside it. Only
 * three of those seconds contain a voice.
 *
 * Seeding the words across the WALL clock puts most of them in a gap where no onset exists, so the
 * DP declines them and the line collapses onto its last reachable onset. But seeding them across
 * voiced FRAMES isn't enough either: a word that should open the second burst lands at the tail of
 * the first, and the DP's search window (0.35 s of WALL time) cannot reach across two bars of guitar
 * to correct it. The window is spent on silence.
 *
 * So do the whole alignment in VOICED seconds. The guitar bars then cost nothing — not in the ruler
 * and not in the search — and 0.35 s of window buys 0.35 s of actual singing, which is what it was
 * always meant to mean. Every word lands in the burst it belongs to, and it falls out for free.
 *
 * A wall time inside a silence maps to the voiced instant the silence began (nothing was sung during
 * it, so it occupies no voiced time at all).
 *
 * ★ TO-WALL MUST CLAMP. `estimateBias` can return a small NEGATIVE bias (a few tens of ms — a
 * perfectly reasonable correction for the bulk of a whole-track word train), and a word seeded
 * right at the very first instant of singing has a voiced-time of ~0 with nothing to absorb it: bias
 * pushes it slightly negative. `toWall`'s binary search had no floor for that case — `cum[m+1] <= v`
 * is false for every m when v is negative, so it silently collapses to lo=0, i.e. TRUE WALL-CLOCK
 * ZERO, not "the start of the voiced signal". On a track with a long instrumental intro those are
 * nowhere near each other: measured on "Coax & Botany" (Gus Dapperton), a real -80ms bias put the
 * first word of the first line at t=0.000 while every other word in that same line correctly landed
 * ~30 SECONDS later, where the singing actually starts. A negative voiced-time isn't a wall time
 * before the track; it's a word whose seed already sat at the voiced-clock's origin. Clamping to
 * [0, total] resolves it to that origin's real wall time — which walks past any leading silence to
 * the true start of singing, same as toWall(0) always did. Symmetric clamp on the upper end for a
 * large positive bias/drift, for the same reason.
 */
export function voicedClock(mask: Float32Array, hop: number) {
  const cum = new Float32Array(mask.length + 1);
  for (let i = 0; i < mask.length; i++) cum[i + 1] = cum[i] + (mask[i] > 0 ? hop : 0);
  const total = cum[mask.length];
  const toVoiced = (t: number): number => {
    const f = Math.floor(t / hop);
    if (f < 0) return 0;
    if (f >= mask.length) return total;
    // Interpolate INSIDE the frame, so two onsets 20 ms apart don't collapse onto one voiced instant.
    return cum[f] + (mask[f] > 0 ? Math.max(0, t - f * hop) : 0);
  };
  const toWall = (v: number): number => {
    v = Math.max(0, Math.min(total, v));
    let lo = 0;
    let hi = mask.length - 1;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (cum[m + 1] <= v) lo = m + 1;
      else hi = m;
    }
    return lo * hop + (mask[lo] > 0 ? v - cum[lo] : 0);
  };
  return { toVoiced, toWall, total };
}

/** Align a word train to vocal onsets IN VOICED TIME, and hand back wall-clock times.
 *
 *  `anchored` = the caller has already fixed the systematic error and is aligning inside a bounded
 *  window (one LRC line). Then the DP must NOT go looking for a bias of its own, and even two onsets
 *  are meaningful. Unanchored (plain lyrics), it needs both guards. */
function alignInVoicedTime(
  seedsWall: number[],
  onsets: number[],
  mask: Float32Array,
  hop: number,
  anchored: boolean,
): { times: number[]; report: AlignReport } {
  const clock = voicedClock(mask, hop);
  const onV: number[] = [];
  const exact = new Map<number, number>(); // voiced instant → the onset's EXACT wall time
  for (const t of onsets) {
    const f = Math.floor(t / hop);
    // An onset sitting in silence is not a word start — it's a click, a breath, or bleed.
    if (f < 0 || f >= mask.length || mask[f] <= 0) continue;
    const v = clock.toVoiced(t);
    if (!exact.has(v)) {
      exact.set(v, t);
      onV.push(v);
    }
  }
  onV.sort((a, b) => a - b);
  const { times, report } = alignWords(
    seedsWall.map(clock.toVoiced),
    onV,
    anchored
      ? { systematic: { bias: 0, drift: 0 }, minOnsets: 1 }
      : // UNANCHORED (plain lyrics): the seeds are cruder — there is no line to pin them — so the DP
        // needs a longer reach, and "decline every onset" has to cost MORE. Inside an anchored line a
        // free word is a legitimate held vowel; with no anchor at all it is a pure guess, and a guess
        // that lands in the wrong burst drags everything after it. Prefer the evidence.
        { window: 0.8, freePenalty: 0.7 },
  );
  // Snap back to the onset's true wall time where the DP chose one (10 ms resolution, not 50 ms).
  return { times: times.map((v) => exact.get(v) ?? clock.toWall(v)), report };
}

/** The wall-clock times of the frames inside [start, end) where there is actually a voice. */
export function voicedFrames(mask: Float32Array, hop: number, start: number, end: number): number[] {
  const a = Math.max(0, Math.round(start / hop));
  const b = Math.min(mask.length, Math.round(end / hop));
  const out: number[] = [];
  for (let i = a; i < b; i++) if (mask[i] > 0) out.push(i * hop);
  return out;
}

/**
 * ★ LAY THE WORDS ACROSS THE VOICED TIME, NOT THE WALL TIME. This is the whole fix, and Rammstein
 * is why.
 *
 * "Du Hast" has one LRC line — "Du, du hast, du hast mich" — that spans about ten seconds, of which
 * roughly three are sung: "Du" … two bars of guitar … "du hast" … two bars … "du hast mich".
 * Spreading six words evenly across TEN seconds puts almost all of them in an instrumental gap where
 * no vocal onset exists, so the DP declines them all and the line collapses onto whatever it can
 * reach. (It did exactly that: 99 of 160 words found no onset, and the whole line slid onto "mich".)
 * A syllable-rate estimate is no better — it crushes all six words into the first 1.5 seconds.
 *
 * The gaps are not part of the singing, so they must not be part of the ruler. Measure each word's
 * position in VOICED seconds — time with the silence taken out — and map back to the wall clock.
 * The instrumental bars then cost nothing, and every word lands in a burst where a voice exists:
 * "Du" in the first, "du hast" in the second, "du hast mich" in the third. It falls out for free.
 *
 * It is also exactly what places PLAIN lyrics that have no line clock at all — the same function,
 * given the whole track as one window.
 */
export function seedOnVoiced(text: string, voiced: number[], hop: number): LyricsWord[] {
  const words = text.split(/\s+/).filter(Boolean);
  // Fewer voiced frames than words means the stem has nothing to say here — let the caller fall back.
  if (!words.length || voiced.length < words.length) return [];
  const syl = words.map(syllables);
  const total = syl.reduce((a, b) => a + b, 0);
  const voicedSec = voiced.length * hop;
  const out: LyricsWord[] = [];
  let acc = 0;
  for (let i = 0; i < words.length; i++) {
    const idx = Math.min(voiced.length - 1, Math.floor((acc / total) * voiced.length));
    out.push({ t: voiced[idx], w: words[i], d: Math.max(0.08, (syl[i] / total) * voicedSec) });
    acc += syl[i];
  }
  for (let i = 1; i < out.length; i++) if (out[i].t <= out[i - 1].t) out[i].t = out[i - 1].t + 0.02;
  return out;
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** A flux peak fires on the RISING edge — physically a frame or two before the energy gate
 *  crosses. Measured on "Coax & Botany": the true "You" attack onsets at 29.22, the mask opens at
 *  29.25, and requiring `mask > 0` at the onset's own frame threw the genuine attack away — which
 *  slid the whole word train one onset late. An onset this close ahead of a voiced run IS that
 *  run's attack; return the frame where the mask opens (or -1 if it never does within reach). */
const ONSET_EDGE_FRAMES = 2;
function voicedFrameFor(mask: Float32Array, f: number): number {
  for (let k = 0; k <= ONSET_EDGE_FRAMES; k++) {
    const j = f + k;
    if (j >= 0 && j < mask.length && mask[j] > 0) return j;
  }
  return -1;
}

/** Every voiced onset in [from, to), sorted ascending. The window+mask filter every line-level
 *  seeder needs, deliberately UNPRUNED by count — see seedOnBursts for why a flat top-K cap is the
 *  wrong place to decide what to keep. */
function windowedOnsets(onsets: number[], from: number, to: number, mask: Float32Array, hop: number): number[] {
  const out: number[] = [];
  for (const t of onsets) {
    if (t < from || t >= to) continue;
    // An onset in SILENCE is not a word start — it's a click, a breath, or a reverb tail.
    if (voicedFrameFor(mask, Math.floor(t / hop)) < 0) continue;
    out.push(t);
  }
  return out; // onsets[] is ascending, so this is too
}

interface Burst {
  attacks: number[];
  /** The CONTAINING voiced run's true edges (extended out from the onsets to the mask's own silence
   *  boundary) — how long was actually sung here, independent of how many times the detector fired. */
  start: number;
  end: number;
}

/** Split a line's onsets into BURSTS — maximal runs where the voiced mask never drops to zero
 *  between consecutive onsets. `onsets` must already be voiced-only and time-ascending. */
function burstsFromOnsets(onsets: number[], mask: Float32Array, hop: number): Burst[] {
  const bursts: Burst[] = [];
  let cur: number[] = [];
  let lastFrame = -1;
  const flush = () => {
    if (!cur.length) return;
    let a = Math.floor(cur[0] / hop);
    while (a > 0 && mask[a - 1] > 0) a--;
    let b = Math.floor(cur[cur.length - 1] / hop);
    while (b + 1 < mask.length && mask[b + 1] > 0) b++;
    bursts.push({ attacks: cur, start: a * hop, end: (b + 1) * hop });
    cur = [];
  };
  for (const t of onsets) {
    // The onset may sit a frame or two ahead of the gate (see voicedFrameFor) — walk continuity
    // from where the mask actually opens, or the edge onset would wrongly split its own burst.
    const f = voicedFrameFor(mask, Math.floor(t / hop));
    if (f < 0) continue; // callers pre-filter; belt and braces
    if (cur.length) {
      let broke = false;
      for (let k = lastFrame; k <= f; k++) {
        if (k < 0 || k >= mask.length || mask[k] <= 0) {
          broke = true;
          break;
        }
      }
      if (broke) flush();
    }
    cur.push(t);
    lastFrame = f;
  }
  flush();
  return bursts;
}

/** Divide `total` integer units across buckets in proportion to `weights` (largest-remainder), then
 *  clamp each bucket to its own `caps` — pushing any overflow to whichever bucket has the most spare
 *  room. Guarantees every bucket's result ≤ its cap whenever sum(caps) ≥ total. */
function allocateQuotas(weights: number[], caps: number[], total: number): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  const q = sum > 0 ? weights.map((w) => (w / sum) * total) : weights.map(() => 0);
  const floors = q.map(Math.floor);
  let used = floors.reduce((a, b) => a + b, 0);
  const order = q.map((r, i) => ({ i, frac: r - floors[i] })).sort((a, b) => b.frac - a.frac);
  for (let k = 0; used < total && k < order.length; k++, used++) floors[order[k].i]++;
  let overflow = 0;
  for (let i = 0; i < floors.length; i++) {
    if (floors[i] > caps[i]) {
      overflow += floors[i] - caps[i];
      floors[i] = caps[i];
    }
  }
  while (overflow > 0) {
    let best = -1;
    for (let i = 0; i < floors.length; i++) {
      if (floors[i] < caps[i] && (best < 0 || caps[i] - floors[i] > caps[best] - floors[best])) best = i;
    }
    if (best < 0) break;
    floors[best]++;
    overflow--;
  }
  return floors;
}

/**
 * ★★★ SEED PER BURST, NOT PER FLAT ATTACK LIST. The correction to the previous attempt
 * (`seedOnAttacks`), found by running this pipeline against the operator's own "Du Hast" vocal stem
 * instead of a synthetic fixture — the real onsets falsify an assumption a fixture couldn't catch.
 *
 * `seedOnAttacks` divided a line's words across every attack in its window in one flat pass, on the
 * theory that a held note attacks once however long it rings. On the real stem it doesn't: "Du," —
 * one word, held — fires TWO onsets (a consonant pluck, then the vowel settling). A flat proportional
 * split can't see those two belong to the SAME word, so it hands the second one to the NEXT word —
 * which then has nothing of its own, and every word after it inherits the shift. Separately, the
 * window reaches to the next LRC line's own timestamp, and if that line's singer comes in even
 * slightly early, its first attack leaks into THIS line's pool and eats a slot near the end. Measured
 * on "Du, du hast, du hast mich": 8 raw attacks for 6 words — 2 from the held "Du," alone, 1 leaked
 * from the next line's pickup — and the flat split put "mich" on the leaked one, past the true end.
 *
 * The fix works in two passes, because the two failures live at different scales.
 *
 * OUTER — which words belong to which BURST: allocated by each burst's own voiced DURATION (not its
 * raw attack count — a burst that over-fired must not also claim an inflated word share, or the
 * held-note bug just reappears one level up), capped so no burst is ever handed more words than it
 * has attacks to put them on (see allocateQuotas). Because the window can leak at most ONE trailing
 * burst — it's already bounded by the next line's own start — a silence gap that dwarfs every other
 * gap in this line is that leak, not a breath inside it, and is dropped before the split ever sees it.
 *
 * INNER — which attack each word in a burst gets: the SAME syllable-weighted proportional index
 * `seedOnAttacks` used, just scoped to one burst's own words and attacks. This is what makes a
 * multi-syllable word still claim several consecutive attacks correctly, and what makes a single-word
 * burst with a spurious extra onset simply take its first (index 0 is where a word starts).
 */
export function seedOnBursts(text: string, onsets: number[], mask: Float32Array, hop: number): LyricsWord[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length || !onsets.length) return [];

  let bursts = burstsFromOnsets(onsets, mask, hop);
  if (bursts.length >= 3) {
    const gaps: number[] = [];
    for (let i = 1; i < bursts.length; i++) gaps.push(bursts[i].start - bursts[i - 1].end);
    const lastGap = gaps[gaps.length - 1];
    const ref = median(gaps.slice(0, -1));
    if (ref > 0 && lastGap > ref * 1.8) bursts = bursts.slice(0, -1); // the next line's pickup, not this line's breath
  }

  const totalAttacks = bursts.reduce((a, b) => a + b.attacks.length, 0);
  // Fewer attacks than words, even across every burst → not enough evidence; caller falls back.
  if (totalAttacks < words.length) return [];

  const syl = words.map(syllables);
  const quotas = allocateQuotas(
    bursts.map((b) => b.end - b.start),
    bursts.map((b) => b.attacks.length),
    words.length,
  );

  const out: LyricsWord[] = [];
  let wi = 0;
  bursts.forEach((b, bi) => {
    const q = quotas[bi];
    if (q <= 0) return;
    const mySyl = syl.slice(wi, wi + q);
    const total = mySyl.reduce((a, c) => a + c, 0) || q;
    let acc = 0;
    for (let k = 0; k < q; k++) {
      // The syllable prior exists to decide which attacks to SKIP when the burst over-fired. When
      // words and attacks match exactly the assignment is forced — one each, in order — and letting
      // the prior reshuffle it maps a 2-syllable word's neighbours onto the same attack (found on a
      // fixture: "and let the summer go", 5 words on 5 attacks, "summer" doubled attack 0 and
      // starved attack 3, and the monotone DP cannot undo an early collision).
      const idx = q === b.attacks.length ? k : Math.min(b.attacks.length - 1, Math.floor((acc / total) * b.attacks.length));
      out.push({ t: b.attacks[idx], w: words[wi + k], d: 0.3 });
      acc += mySyl[k] || 1;
    }
    wi += q;
  });

  for (let i = 1; i < out.length; i++) if (out[i].t <= out[i - 1].t) out[i].t = out[i - 1].t + 0.02;
  return out;
}

/**
 * A 0/1 mask from the vocal stem's energy envelope: 1 where someone is actually singing.
 *
 * ★ A THRESHOLD RELATIVE TO THE PEAK IS NOT ROBUST, AND EVERYTHING ELSE HERE RESTS ON THIS MASK.
 * It used to gate at 6% of the loudest frame. That is fine on a clean separation and useless on a
 * real one: a Rammstein vocal stem carries continuous guitar and drum BLEED, comfortably above 6%
 * of peak, so every frame came back "voiced" — and a mask of all ones quietly destroys everything
 * downstream. The voiced clock collapses back into the wall clock (so the fix for held lines does
 * nothing). Word seeds spread across the instrumental bars again. Onsets in the gaps can no longer
 * be filtered, so guitar transients become candidate word starts. And `spanCoverage` reports 97% —
 * because EVERY span overlaps an all-ones mask, by construction.
 *
 * That last one is the trap: the confidence number looked excellent precisely BECAUSE the mask had
 * failed. An estimator with nothing to estimate will estimate noise, confidently.
 *
 * So gate on the stem's OWN distribution, not on its peak: find the noise floor (where the bleed
 * lives) and the singing, and put the line a quarter of the way up between them. On a clean stem
 * the floor is ~0 and this is just "a quarter of loud"; on a bleedy one it rises with the bleed and
 * still separates. `voicedFraction` below is what lets us NOTICE when it hasn't.
 */
export function maskFromEnergy(env: Float32Array): Float32Array {
  const m = new Float32Array(env.length);
  if (env.length < 8) return m;
  const sorted = Float32Array.from(env).sort(); // TypedArray sorts numerically
  const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  const floor = pct(0.2); // bleed, room tone, reverb tails — whatever never stops
  const voice = pct(0.95); // the singing
  if (voice <= 1e-6) return m; // a silent stem is not "voiced everywhere"
  // Between the floor and the voice, nearer the floor — a quiet consonant is still singing.
  // Never below 8% of the voice, so a stem with NO floor at all can't gate on dither.
  const gate = Math.max(floor + 0.25 * (voice - floor), voice * 0.08);
  for (let i = 0; i < env.length; i++) m[i] = env[i] > gate ? 1 : 0;
  return m;
}

/** How much of the track the mask calls "voiced".
 *
 *  ★ THE MASK'S OWN HONESTY CHECK. Near 1 means the gate failed and everything measured against it
 *  — the offset, the coverage, the voiced clock — is meaningless, however confident it looks. A
 *  metric must be able to tell you when it has stopped measuring. */
export function voicedFraction(mask: Float32Array): number {
  if (!mask.length) return 0;
  let n = 0;
  for (const v of mask) if (v > 0) n++;
  return n / mask.length;
}

/**
 * Slide the LRC's singing-mask against the vocal stem's and return the lag (in seconds) where they
 * agree best, plus how strongly (0..1).
 *
 * Scored with a correlation that is normalised by BOTH masks' mass, so a lag that simply parks the
 * lyrics on top of the loudest part of the song can't win by covering more ground. Silence has to
 * line up with silence too — which is what makes an instrumental break a feature rather than a gap.
 */
export function coarseOffset(
  lrcMask: Float32Array,
  vocalMask: Float32Array,
  hop: number,
  maxLagSec = 30,
): { offset: number; confidence: number } {
  const n = Math.min(lrcMask.length, vocalMask.length);
  if (n < 20) return { offset: 0, confidence: 0 };
  const maxLag = Math.min(Math.round(maxLagSec / hop), n - 1);

  let best = 0;
  let bestScore = -Infinity;
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    // hits = frames where both say "singing"; the two masses normalise it (a Dice coefficient), so
    // a lag can't score by being generous — it has to match the SHAPE.
    let hits = 0;
    let a = 0;
    let b = 0;
    for (let i = 0; i < n; i++) {
      const j = i + lag; // the LRC frame i lands on vocal frame i+lag
      if (j < 0 || j >= n) continue;
      const L = lrcMask[i];
      const V = vocalMask[j];
      a += L;
      b += V;
      if (L > 0 && V > 0) hits++;
    }
    if (a < 10 || b < 10) continue;
    const dice = (2 * hits) / (a + b);
    // Prefer the SMALLEST offset that explains the data — same reasoning as align.ts's LAG_REG. A
    // song is repetitive, so a verse can land on a later verse and score nearly as well.
    //
    // ★ PRICED PER SECOND, NOT PER FRAME. It was per frame, which at a 50 ms hop meant a 5-second
    // offset cost 0.4 against a Dice score that cannot exceed 1.0 — so the true peak could never
    // win and this function returned zero every single time. The regulariser must be small enough
    // that it only ever breaks a TIE; if it can outvote the evidence it isn't a prior, it's a veto.
    const score = dice - 0.004 * Math.abs(lag * hop);
    if (score > bestScore) {
      bestScore = score;
      best = lag;
    }
  }
  if (bestScore <= 0) return { offset: 0, confidence: 0 };
  return { offset: best * hop, confidence: 0 };
}

/**
 * The share of LRC lines that, at this offset, actually land on someone singing.
 *
 * ★ THIS, NOT THE CORRELATION SCORE, IS WHAT WE GATE ON — and the test is what taught me why. A
 * mismatched LRC (one written for a different rendering of the song) still scored 0.52 by Dice,
 * because a single long block of lyrics happening to overlap a single long block of vocals is enough
 * to move a lot of MASS. Total agreement can be bought by one lucky region. "Did nine lines out of
 * ten land on a voice?" cannot: it is a statement about the WHOLE song, and it is exactly the
 * question whose answer decides whether these lyrics belong to this audio.
 */
export function spanCoverage(
  spans: { start: number; end: number }[],
  vocalMask: Float32Array,
  hop: number,
  offset: number,
  need = 0.5,
): number {
  if (!spans.length) return 0;
  let hit = 0;
  for (const s of spans) {
    const a = Math.max(0, Math.round((s.start + offset) / hop));
    const b = Math.min(vocalMask.length, Math.round((s.end + offset) / hop));
    if (b <= a) continue;
    let v = 0;
    for (let i = a; i < b; i++) if (vocalMask[i] > 0) v++;
    if (v / (b - a) >= need) hit++;
  }
  return hit / spans.length;
}

/** Below this, the LRC and the audio disagree so badly that the file is probably for a different
 *  rendering of the song (a live take, a different edit). Better to leave the LRC's own clock alone
 *  than to drag the whole track onto a coincidence.
 *
 *  ★ CALIBRATED AGAINST A REAL TRACK, NOT A GUESS. The gate was 0.4, and on a two-line fixture a
 *  shift that landed ONE line on singing scored 0.5 — passed the gate, and dragged the whole track
 *  12.75 SECONDS. "Half the lines matched" is not evidence; it's a coin. A genuinely correct match
 *  on real audio scores 94% (measured on the operator's Du Hast: 30 of 32 lines). So the bar is 0.6,
 *  which a real match clears easily and a coincidence does not. */
const MIN_CONFIDENCE = 0.6;
/** ...and a handful of lines cannot support a whole-track shift at all. With three lines, one lucky
 *  landing is 33% and two is 67% — the statistic has no resolution. Leave the clock alone. */
const MIN_LINES_FOR_SHIFT = 4;

/** When the LRC's own clock is already credible, a shift may only POLISH it — no further than a
 *  line's own slack. Anything bigger pushes every line's evidence window past its own first attack
 *  and onto its neighbour's audio. */
const MAX_POLISH_SHIFT = 0.5;

/**
 * The whole-track shift decision, extracted so it can be tested (convergence.ts's pattern: extract
 * the decision, test the decision). Returns the shift to apply — 0 means "leave the LRC clock alone".
 *
 * ★ CALIBRATED ON TWO REAL TRACKS, AND THE SECOND ONE WAS A LIVE REGRESSION. The rule used to be
 * "shift whenever coverage improves at all", and on Britney's "I Wanna Go" (video cut, LRC duration-
 * matched and essentially CORRECT: first line stamped 9.04, voice enters 9.25) the correlator still
 * found +1.15 s, because 0.740 beats 0.680 — a THREE-line gain on a fifty-line song, pure noise on a
 * 62%-voiced mask. The shift pushed every line's window past its own first attack, the DP could only
 * snap late, and the whole track came out seconds behind the singer. Meanwhile Du Hast's stamps
 * really are ~0.4 s late (31.13 vs a measured attack at 30.73), as-is coverage 0.750, shifted 0.906 —
 * a small shift a credible clock genuinely needs.
 *
 * What separates the true case from the false one is NOT the coverage delta (a per-line statistic
 * with N-dependent noise) — it is the SIZE of the move against a clock that already clears the trust
 * bar. A credible clock may be polished (≤ MAX_POLISH_SHIFT); it may never be yanked. A clock that
 * FAILS the bar as-is is the different-cut case the shift was built for, and the full rescue stays.
 */
export function decideShift(o: { lines: number; offset: number; confidence: number; asIs: number }): number {
  const trust = o.lines >= MIN_LINES_FOR_SHIFT && o.confidence >= MIN_CONFIDENCE && o.confidence > o.asIs;
  if (!trust) return 0;
  if (o.asIs >= MIN_CONFIDENCE && Math.abs(o.offset) > MAX_POLISH_SHIFT) return 0;
  return o.offset;
}

export interface LrcAlignInput {
  /** Lines with LRC's start/end (its own clock) and the text. */
  lines: LyricsLine[];
  /** Vocal-stem onsets, seconds — the evidence. */
  onsets: number[];
  /** How far above its neighbourhood each onset's flux spike stood. A note ATTACK towers over a
   *  vibrato ripple inside a held vowel; without this they are indistinguishable. */
  strengths?: number[];
  /** Vocal-stem energy envelope and its frame period. */
  env: Float32Array;
  hop: number;
  duration: number;
}

/**
 * LRC lines + a vocal stem → word-timed lyrics.
 *
 * 1) Find the whole-track offset from STRUCTURE (mask correlation) — seconds, not milliseconds.
 * 2) Seed each word inside its line by syllable count.
 * 3) Hand the whole word train to the DP, which places it on the real onsets.
 */
export function alignLrc(i: LrcAlignInput): { lines: LyricsLine[]; report: LrcReport } {
  const frames = Math.max(1, Math.round(i.duration / i.hop));
  const vocal = maskFromEnergy(i.env);
  const voiced = voicedFraction(vocal);
  // 1) The whole-track offset, from STRUCTURE. Both masks are BURSTS (a line is sung for as long as
  //    its syllables need, not until the next line starts) — that shape is what makes the
  //    correlation sharp. A solid block from first lyric to last would slide anywhere and score the
  //    same.
  const spans = sungSpans(i.lines, i.duration);
  const lrcMask = maskFromLines(spans, frames, i.hop);
  const { offset } = coarseOffset(lrcMask, vocal, i.hop);
  // How much of the song actually agrees at that offset — see spanCoverage for why this and not the
  // correlation score. Compare against doing nothing: a shift has to EARN its place.
  const confidence = spanCoverage(spans, vocal, i.hop, offset);
  const asIs = spanCoverage(spans, vocal, i.hop, 0);

  // A weak correlation means this LRC probably isn't describing the audio we're holding — and a
  // STRONG-looking one can still be noise if the clock was already right (see decideShift). Take the
  // words (they're always right) and move them only as far as the evidence actually warrants.
  const shift = decideShift({ lines: i.lines.length, offset, confidence, asIs });

  // 2) Align EACH LINE INSIDE ITS OWN WINDOW.
  //
  // ★ THIS IS WHAT THE LINE TIMINGS ARE FOR, AND I THREW IT AWAY ONCE. The first version ran ONE DP
  // over the whole track. That lets a word reach past the end of its own line and grab the next
  // line's first onset — and once one word slips, monotonicity drags every word after it along. On
  // the very first test fixture the whole track came out shifted by exactly one onset. A line is an
  // ANCHOR: its words belong to ITS onsets, and nothing else's. Confining the DP to the line makes
  // "distribute these six words over these six onsets, in order, one each" very nearly FORCED —
  // which is the entire reason a line-synced file is worth more than a bare word list.
  //
  // Inside the line, everything happens in VOICED time (see voicedClock), so the two bars of guitar
  // between "du hast" and "du hast mich" cost nothing — not in the ruler, and not in the DP's
  // search window.
  const shifted = i.lines.map((l, li) => ({
    ...l,
    start: l.start + shift,
    end: Math.min(li + 1 < i.lines.length ? i.lines[li + 1].start + shift : i.duration, i.duration),
  }));
  const out: LyricsLine[] = shifted.map((l) => ({ ...l, words: [] as LyricsWord[] }));
  let snapped = 0;
  let free = 0;
  let words = 0;
  let applied = false;
  shifted.forEach((l, li) => {
    // Look back a little: an LRC cue is often stamped a beat AFTER the singer actually comes in.
    const from = Math.max(0, l.start - 0.3, li > 0 ? shifted[li - 1].end : 0);
    // THIS line's evidence, and only it — every voiced onset in the window. Burst structure, not a
    // flat count, decides what each word gets (see seedOnBursts).
    const windowed = windowedOnsets(i.onsets, from, l.end, vocal, i.hop);
    const mine = windowed;
    // ★ Seed PER BURST. Voiced TIME is the wrong ruler (a held "Duuuu" buys seconds and is still one
    // word), and a FLAT attack list is only half the fix — a held note can re-attack, and the window
    // can catch the next line's own pickup note, so a flat proportional split silently borrows a
    // slot from the wrong word. Bursts (the mask's own silences) are partitions neither mistake can
    // cross.
    let ws = seedOnBursts(l.text, windowed, vocal, i.hop);
    if (!ws.length) {
      // Too few attacks to place the words on — fall back to voiced time, then to the LRC's clock.
      const voiced = voicedFrames(vocal, i.hop, from, l.end);
      ws = seedOnVoiced(l.text, voiced, i.hop);
      if (!ws.length) ws = seedLine(l.text, l.start, Math.min(l.end, spans[li].end + shift));
    }
    if (!ws.length) return;
    words += ws.length;
    const { times, report } = alignInVoicedTime(ws.map((w) => w.t), mine, vocal, i.hop, true);
    if (report.applied) applied = true;
    snapped += report.snapped;
    free += report.free;
    out[li].words = ws.map((w, k) => ({ t: times[k], w: w.w, d: w.d }));
  });
  if (!words) {
    return {
      lines: shifted,
      report: { offset: shift, confidence, voiced, lines: shifted.length, words: 0, bias: 0, drift: 0, snapped: 0, free: 0, medianMove: 0, applied: false },
    };
  }
  const report: AlignReport = { bias: 0, drift: 0, snapped, free, medianMove: 0, applied };
  for (let li = 0; li < out.length; li++) {
    const ws = out[li].words!;
    if (!ws.length) continue;
    // A word is held until the next word starts (capped by its syllable-prior duration, so a word
    // before a long instrumental gap doesn't read as being sung for eight seconds).
    for (let k = 0; k < ws.length; k++) {
      const next = k + 1 < ws.length ? ws[k + 1].t : undefined;
      const room = next !== undefined ? next - ws[k].t : (ws[k].d ?? 0.3);
      ws[k].d = Math.max(0.08, Math.min(ws[k].d ?? room, room));
    }
    out[li].start = ws[0].t;
    out[li].end = Math.max(ws[ws.length - 1].t + (ws[ws.length - 1].d ?? 0.3), out[li].start + 0.2);
  }
  // Keep the ribbon monotone even if the DP left a line's last word past the next line's first.
  for (let li = 1; li < out.length; li++) {
    if (out[li - 1].end > out[li].start) out[li - 1].end = Math.max(out[li - 1].start + 0.1, out[li].start);
  }

  return {
    lines: out,
    report: { ...report, offset: shift, confidence, voiced, lines: out.length, words },
  };
}

/**
 * PLAIN lyrics — the right words, and NO clock at all. About 1 song in 16 (6% of a real library);
 * "Coax & Botany" is one, and it used to get nothing.
 *
 * ★ THIS IS WHAT FORCED ALIGNMENT IS ACTUALLY FOR. Having no line times is not a missing input, it
 * is the ORDINARY case the technique was invented for: you know the words, you know their order, and
 * you measure where they land. The whole track becomes one window, and the same voiced-time ruler
 * that fixed Rammstein lays the words out across it — the instrumental intro, the solo and the outro
 * cost nothing, because they contain no voice and therefore no ruler.
 *
 * ⚠ AND IT IS HONESTLY WEAKER, so it says so. With line-synced lyrics every line is an ANCHOR, and
 * an error is contained between two of them. Here there are no anchors: one mistake — an "ooh" the
 * lyric sheet doesn't print, a backing vocal, an ad-lib — shifts everything after it, with nothing to
 * pull it back. So it reports confidence 0 and a source of its own, and the ribbon says the timing is
 * estimated. The words are still ground truth; only their placement is a derivation.
 */
/** The voiced mask as RUNS — maximal singing stretches, with sub-`mergeGap` silences (a breath, a
 *  consonant stop) folded in so a phrase reads as one run, not five. */
export function voicedRuns(mask: Float32Array, hop: number, mergeGap = 0.6): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  let from = -1;
  for (let f = 0; f <= mask.length; f++) {
    const v = f < mask.length && mask[f] > 0;
    if (v && from < 0) from = f;
    else if (!v && from >= 0) {
      const start = from * hop;
      const end = f * hop;
      if (out.length && start - out[out.length - 1].end < mergeGap) out[out.length - 1].end = end;
      else out.push({ start, end });
      from = -1;
    }
  }
  return out;
}

/** No line may be asked to sing faster than this. 5 syllables a second, SUSTAINED for a whole line,
 *  is already patter — a 10-syllable lyric physically does not fit a 1.8-second burst, and that
 *  impossibility is the only content-free evidence we have against seating it there. */
const MIN_SEC_PER_SYL = 0.2;

/**
 * Assign ordered LINES to ordered voiced RUNS — the anchors plain lyrics don't come with.
 *
 * ★ WHY THIS EXISTS — MEASURED ON THE OPERATOR'S "COAX & BOTANY", NOT GUESSED. The sheet prints
 * "Oh, oh-whoa, oh" twice mid-song and four times in the bridge; the recording SINGS it three and
 * seven times. A flat proportional seed consumes bursts strictly in order, so every unprinted
 * ad-lib repeat dragged the following printed line one burst early — the verse-3 reprise displayed
 * an entire silence-gap before it was sung (the exact live complaint). The fix is not to know the
 * content; it is to respect two structural facts: a dense line cannot fit a short burst (the hard
 * constraint above), and a run nothing fits may simply hold NO printed line — showing nothing
 * during an ad-lib the sheet doesn't print is correct, and pulling a verse onto it is not.
 *
 * DP over (lines consumed, runs consumed); each run takes a contiguous — possibly empty — slice of
 * lines, subject to fit; cost per run is the squared gap between the syllables it received and the
 * syllables its share of the voiced time predicts (rate R = total syllables / total voiced time).
 * Returns the run index per line, or null when the lines can't fit the runs at all (fall back to
 * the flat seed — a wrong ruler beats no ruler).
 */
export function assignLinesToRuns(syl: number[], caps: number[]): number[] | null {
  const N = syl.length;
  const M = caps.length;
  if (!N || !M) return null;
  const totalSyl = syl.reduce((a, b) => a + b, 0);
  const totalCap = caps.reduce((a, b) => a + b, 0);
  if (totalSyl <= 0 || totalCap <= 0) return null;
  const R = totalSyl / totalCap;
  // prefix sums: syllables and minimum seconds of lines [0, k)
  const pSyl = [0];
  const pMin = [0];
  for (let k = 0; k < N; k++) {
    pSyl.push(pSyl[k] + syl[k]);
    pMin.push(pMin[k] + syl[k] * MIN_SEC_PER_SYL);
  }
  const INF = Infinity;
  // f[j][k] = best cost with the first j runs holding the first k lines
  const f: number[][] = Array.from({ length: M + 1 }, () => new Array<number>(N + 1).fill(INF));
  const from: number[][] = Array.from({ length: M + 1 }, () => new Array<number>(N + 1).fill(-1));
  f[0][0] = 0;
  for (let j = 1; j <= M; j++) {
    const cap = caps[j - 1];
    const want = R * cap;
    for (let k = 0; k <= N; k++) {
      // run j-1 takes lines [m, k) — m === k is the empty run
      for (let m = k; m >= 0; m--) {
        if (pMin[k] - pMin[m] > cap) break; // one more line can only make the slice longer
        const prev = f[j - 1][m];
        if (prev === INF) continue;
        const got = pSyl[k] - pSyl[m];
        const cost = prev + (got - want) * (got - want);
        if (cost < f[j][k]) {
          f[j][k] = cost;
          from[j][k] = m;
        }
      }
    }
  }
  if (f[M][N] === INF) return null;
  const runOf = new Array<number>(N).fill(-1);
  let k = N;
  for (let j = M; j >= 1; j--) {
    const m = from[j][k];
    for (let x = m; x < k; x++) runOf[x] = j - 1;
    k = m;
  }
  return runOf;
}

export function alignPlain(i: {
  text: string[];
  onsets: number[];
  strengths?: number[];
  env: Float32Array;
  hop: number;
  duration: number;
}): { lines: LyricsLine[]; report: LrcReport } {
  const vocal = maskFromEnergy(i.env);
  const voiced = voicedFrames(vocal, i.hop, 0, i.duration);
  const texts = i.text.filter((t) => t.trim());
  const idle: LrcReport = {
    offset: 0,
    confidence: 0,
    voiced: voicedFraction(vocal),
    lines: texts.length,
    words: 0,
    bias: 0,
    drift: 0,
    snapped: 0,
    free: 0,
    medianMove: 0,
    applied: false,
  };
  if (!texts.length || voiced.length < 20) return { lines: [], report: idle };

  // ★ STRUCTURE FIRST. Assign the lines to the mask's own voiced runs (see assignLinesToRuns — an
  // unprinted ad-lib burst may hold NO line, and a dense line may not sit on a burst it can't fit),
  // synthesize each line's clock from its run, and from there this is exactly the anchored problem
  // alignLrc already solves. Plain lyrics stop being anchorless; the anchors come from the audio.
  const runs = voicedRuns(vocal, i.hop);
  const lineSyl = texts.map((t) =>
    t
      .split(/\s+/)
      .filter(Boolean)
      .reduce((a, w) => a + syllables(w), 0),
  );
  const runOf = runs.length >= 2 ? assignLinesToRuns(lineSyl, runs.map((r) => r.end - r.start)) : null;
  if (runOf) {
    const anchored: LyricsLine[] = [];
    for (let j = 0; j < runs.length; j++) {
      const mine: number[] = [];
      for (let li = 0; li < texts.length; li++) if (runOf[li] === j) mine.push(li);
      if (!mine.length) continue;
      // Slice the run among its lines by syllable share — the same prior the seeds use.
      const total = mine.reduce((a, li) => a + lineSyl[li], 0) || mine.length;
      let at = runs[j].start;
      for (const li of mine) {
        const span = ((lineSyl[li] || 1) / total) * (runs[j].end - runs[j].start);
        anchored.push({ start: at, end: at + span, text: texts[li] });
        at += span;
      }
    }
    const { lines, report } = alignLrc({ ...i, lines: anchored });
    // The anchors were derived from this very audio, so agreement with it measures nothing.
    // Estimated stays confidence 0, offset 0 — same honesty rule as below.
    return { lines, report: { ...report, offset: 0, confidence: 0 } };
  }

  // No usable run structure (or the lines can't fit it) — the flat seed: one word train across the
  // whole track's voiced time, grouped back into lines afterwards. A wrong ruler beats no ruler.
  const seeds = seedOnVoiced(texts.join(" "), voiced, i.hop);
  if (!seeds.length) return { lines: [], report: idle };
  const { times, report } = alignInVoicedTime(seeds.map((w) => w.t), i.onsets, vocal, i.hop, false);

  const out: LyricsLine[] = [];
  let k = 0;
  for (const text of texts) {
    const n = text.split(/\s+/).filter(Boolean).length;
    const ws: LyricsWord[] = [];
    for (let j = 0; j < n && k < seeds.length; j++, k++) ws.push({ t: times[k], w: seeds[k].w, d: seeds[k].d });
    if (!ws.length) continue;
    for (let j = 0; j < ws.length; j++) {
      const next = j + 1 < ws.length ? ws[j + 1].t : undefined;
      const room = next !== undefined ? next - ws[j].t : (ws[j].d ?? 0.3);
      ws[j].d = Math.max(0.08, Math.min(ws[j].d ?? room, room));
    }
    out.push({ start: ws[0].t, end: Math.max(ws[ws.length - 1].t + (ws[ws.length - 1].d ?? 0.3), ws[0].t + 0.2), text, words: ws });
  }
  for (let li = 1; li < out.length; li++) {
    if (out[li - 1].end > out[li].start) out[li - 1].end = Math.max(out[li - 1].start + 0.1, out[li].start);
  }
  // confidence stays 0: there is no anchor to measure agreement against. Saying "94%" here would be
  // a number with nothing behind it, which is worse than saying nothing.
  return { lines: out, report: { ...report, offset: 0, confidence: 0, voiced: voicedFraction(vocal), lines: out.length, words: seeds.length } };
}
