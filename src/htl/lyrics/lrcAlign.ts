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

/** The end of the voiced run that a line starts in — the vocal stem's own answer to "when did they
 *  stop singing this line?", which beats any syllable estimate. Short gaps (a breath) don't end it. */
function voicedEnd(mask: Float32Array, hop: number, start: number, hardEnd: number): { start: number; end: number } {
  const last = Math.min(mask.length - 1, Math.floor(hardEnd / hop));
  let f = Math.max(0, Math.round(start / hop));
  while (f <= last && !mask[f]) f++; // the LRC start may sit slightly before the first note
  if (f > last) return { start, end: hardEnd }; // no voice in this window → keep the estimate
  const GAP = Math.max(1, Math.round(0.3 / hop)); // a breath is not the end of a line
  let end = f;
  let gap = 0;
  for (let i = f; i <= last; i++) {
    if (mask[i]) {
      end = i;
      gap = 0;
    } else if (++gap > GAP) break;
  }
  return { start: f * hop, end: Math.min(hardEnd, (end + 1) * hop) };
}

/** A 0/1 mask from the vocal stem's energy envelope: 1 where the stem is actually making sound.
 *
 *  This is trivially reliable ONLY because the vocal is isolated. On a full mix it would be
 *  hopeless — the drums never stop. It is the one place our stem separation buys something no
 *  amount of cleverness could replace. */
export function maskFromEnergy(env: Float32Array, floorFrac = 0.06): Float32Array {
  const m = new Float32Array(env.length);
  if (!env.length) return m;
  let peak = 0;
  for (const v of env) if (v > peak) peak = v;
  if (peak <= 0) return m;
  const thr = peak * floorFrac;
  for (let i = 0; i < env.length; i++) m[i] = env[i] > thr ? 1 : 0;
  return m;
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
 *  than to drag the whole track onto a coincidence. */
const MIN_CONFIDENCE = 0.4;

export interface LrcAlignInput {
  /** Lines with LRC's start/end (its own clock) and the text. */
  lines: LyricsLine[];
  /** Vocal-stem onsets, seconds — the evidence. */
  onsets: number[];
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

  // A weak correlation means this LRC probably isn't describing the audio we're holding. Take the
  // words (they're still right) but don't shove them somewhere on the strength of a coincidence.
  const shift = confidence >= MIN_CONFIDENCE && confidence > asIs ? offset : 0;

  // 2) Seed every word, across every line, in one train — the DP wants the whole sequence so it can
  //    see the global bias and keep the words in order across line boundaries. Each line's span is
  //    now the VOCAL STEM's answer ("you stopped singing here"), falling back to the syllable
  //    estimate where the stem has nothing to say.
  const shifted = i.lines.map((l, li) => {
    const start = l.start + shift;
    const hard = Math.min(li + 1 < i.lines.length ? i.lines[li + 1].start + shift : i.duration, i.duration);
    const est = Math.min(hard, spans[li].end + shift);
    const v = voicedEnd(vocal, i.hop, start, hard);
    // Trust the stem's voiced run when it found one, but never let a line run past the next.
    const end = v.end > start + 0.2 ? v.end : est;
    return { ...l, start: Math.max(start, Math.min(v.start, start + 0.5)), end };
  });
  const seeds: LyricsWord[] = [];
  const owner: number[] = []; // which line each word came from
  shifted.forEach((l, li) => {
    for (const w of seedLine(l.text, l.start, l.end)) {
      seeds.push(w);
      owner.push(li);
    }
  });
  if (!seeds.length) {
    return {
      lines: shifted,
      report: { offset: shift, confidence, lines: shifted.length, words: 0, bias: 0, drift: 0, snapped: 0, free: 0, medianMove: 0, applied: false },
    };
  }

  // 3) The DP. It removes whatever systematic error survives the coarse pass, then pulls each word
  //    onto a real vocal onset — declining where a held vowel genuinely has none.
  const { times, report } = alignWords(
    seeds.map((w) => w.t),
    i.onsets,
  );

  // Rebuild the lines from the aligned words. A line now STARTS at its first word (which is a
  // measured vocal onset) rather than at whatever the LRC file guessed.
  const out: LyricsLine[] = shifted.map((l) => ({ ...l, words: [] as LyricsWord[] }));
  for (let k = 0; k < seeds.length; k++) {
    out[owner[k]].words!.push({ t: times[k], w: seeds[k].w, d: seeds[k].d });
  }
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
    report: { ...report, offset: shift, confidence, lines: out.length, words: seeds.length },
  };
}
