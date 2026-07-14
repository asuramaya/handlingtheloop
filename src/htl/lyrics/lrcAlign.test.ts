import { describe, it, expect } from "vitest";
import { syllables, seedLine, maskFromLines, maskFromEnergy, voicedFraction, coarseOffset, spanCoverage, alignLrc, alignPlain } from "./lrcAlign";
import { parseLrc, cleanTitle, primaryArtist } from "./lrclib";
import type { LyricsLine } from "./types";

describe("parseLrc", () => {
  it("reads the format, including the ways real files bend it", () => {
    const lrc = [
      "[ar:Some Artist]", // metadata — not a lyric
      "[00:31.48] Like the legend of the phoenix",
      "[01:02.5] tenths, not hundredths",
      "[01:03.050] and milliseconds",
      "[00:12.00][02:44.00] a repeated chorus line", // one line, two cues
      "[00:20.00]   ", // a TIMED BLANK = an instrumental gap, not a lyric
      "not timed at all",
    ].join("\n");
    const out = parseLrc(lrc);
    expect(out.map((l) => l.text)).toEqual([
      "a repeated chorus line",
      "Like the legend of the phoenix",
      "tenths, not hundredths",
      "and milliseconds",
      "a repeated chorus line",
    ]);
    expect(out[1].t).toBeCloseTo(31.48, 2);
    expect(out[2].t).toBeCloseTo(62.5, 2); // ".5" is five TENTHS
    expect(out[3].t).toBeCloseTo(63.05, 2); // ".050" is fifty MILLISECONDS
    expect(out[0].t).toBeCloseTo(12, 2); // sorted, so the 00:12 cue leads
  });

  it("a bracket mid-lyric is not a timestamp", () => {
    expect(parseLrc("[00:05.00] shout [00:06.00] out")[0].text).toBe("shout [00:06.00] out");
  });
});

describe("matching the real mess in our library", () => {
  it("★ strips the version noise and the co-credits that LRCLIB doesn't index on", () => {
    // These are verbatim rows from the operator's own track_identity table.
    expect(primaryArtist("Afrojack, Eva Simons")).toBe("Afrojack");
    expect(cleanTitle("Take Over Control (radio edit)")).toBe("Take Over Control");
    expect(primaryArtist("The Weeknd, JENNIE, Lily‐Rose Depp")).toBe("The Weeknd");
    expect(cleanTitle("Die for You (remix)")).toBe("Die for You");
    expect(cleanTitle("Billie Jean - 2011 Remaster")).toBe("Billie Jean");
  });
  it("leaves a clean title alone", () => {
    expect(cleanTitle("Walking on a Dream")).toBe("Walking on a Dream");
    expect(primaryArtist("Drake")).toBe("Drake");
  });
});

describe("syllables — a length prior, not a pronunciation claim", () => {
  it("counts vowel groups and eats the silent e", () => {
    expect(syllables("time")).toBe(1);
    expect(syllables("legend")).toBe(2);
    expect(syllables("beautiful")).toBe(3);
    expect(syllables("I")).toBe(1);
  });
  it("★ stays honest in the languages Whisper was worst at", () => {
    // No acoustic model = nothing to be monolingual about. One character block ≈ one syllable.
    expect(syllables("こんにちは")).toBe(5);
    expect(syllables("까탈레나")).toBe(4);
    expect(syllables("corazón")).toBe(3);
  });
  it("never returns zero — a word always takes some time", () => {
    expect(syllables("!?")).toBe(1);
    expect(syllables("")).toBe(1);
  });
});

describe("seedLine", () => {
  it("gives a long word more of the line than a short one", () => {
    const ws = seedLine("I am beautiful", 10, 13); // 1 + 1 + 3 syllables over 3 s
    expect(ws.map((w) => w.w)).toEqual(["I", "am", "beautiful"]);
    expect(ws[0].t).toBeCloseTo(10, 2);
    expect(ws[1].t).toBeCloseTo(10.6, 1); // after 1 of 5 syllables
    expect(ws[2].t).toBeCloseTo(11.2, 1); // after 2 of 5
    expect(ws[2].d!).toBeGreaterThan(ws[0].d!); // "beautiful" is held longer than "I"
  });
});

describe("coarseOffset — the whole-track shift align.ts structurally cannot find", () => {
  const HOP = 0.05;
  // A song shape: sing, instrumental break, sing, break, sing. The breaks are what make it findable.
  const spans = [
    [10, 25],
    [40, 55],
    [70, 90],
  ];
  const frames = Math.round(120 / HOP);
  const truth = maskFromLines(spans.map(([start, end]) => ({ start, end })), frames, HOP);

  it("★ finds a multi-SECOND offset — the case that mattered and that ±0.8s could never reach", () => {
    // The YouTube upload opens with 6 s of label ident, so the audio is 6 s LATE vs the LRC clock.
    const audio = maskFromLines(spans.map(([s, e]) => ({ start: s + 6, end: e + 6 })), frames, HOP);
    const { offset } = coarseOffset(truth, audio, HOP);
    expect(offset).toBeCloseTo(6, 1);
    // ...and at that offset, EVERY line lands on singing.
    const lrcSpans = spans.map(([start, end]) => ({ start, end }));
    expect(spanCoverage(lrcSpans, audio, HOP, offset)).toBe(1);
  });

  it("finds a NEGATIVE offset (the LRC was written against a version with a longer intro)", () => {
    const audio = maskFromLines(spans.map(([s, e]) => ({ start: s - 4, end: e - 4 })), frames, HOP);
    expect(coarseOffset(truth, audio, HOP).offset).toBeCloseTo(-4, 1);
  });

  it("agrees with itself at zero when nothing is wrong", () => {
    expect(coarseOffset(truth, truth, HOP).offset).toBeCloseTo(0, 2);
  });

  it("★ a WRONG rendering can still fake a good correlation — coverage is what catches it", () => {
    // A different take: the singing lands nowhere near where this LRC says it should. Sliding its
    // one long block onto our one long block moves a LOT of mass — Dice ≈ 0.52, which looks
    // respectable. But only ONE line in three actually lands on a voice, and that is the number
    // that tells the truth. This is why the gate is coverage, not correlation.
    const other = maskFromLines([{ start: 5, end: 12 }, { start: 30, end: 34 }, { start: 95, end: 118 }], frames, HOP);
    const lrcSpans = spans.map(([start, end]) => ({ start, end }));
    const { offset } = coarseOffset(truth, other, HOP);
    expect(spanCoverage(lrcSpans, other, HOP, offset)).toBeLessThan(0.5);
  });
});

describe("maskFromEnergy — the gate everything else rests on", () => {
  it("calls the loud parts voiced and the quiet parts not", () => {
    const env = Float32Array.from([0, 0, 0.9, 1, 0.8, 0, 0, 0.5]);
    expect(Array.from(maskFromEnergy(env))).toEqual([0, 0, 1, 1, 1, 0, 0, 1]);
  });

  it("an all-silent stem is not 'voiced everywhere'", () => {
    expect(Array.from(maskFromEnergy(new Float32Array(8)))).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it("★★ a LEAKY stem (guitar bleed) must not read as singing everywhere", () => {
    // Rammstein's vocal stem carries continuous guitar/drum bleed at maybe 30% of the vocal's level.
    // The old gate was 6% OF PEAK, so the bleed cleared it and EVERY frame came back voiced — which
    // silently destroyed everything downstream (the voiced clock collapsed to the wall clock, the
    // word seeds spread back across the instrumental bars, and spanCoverage reported 97% because
    // every span overlaps a mask of all ones). The confidence looked superb BECAUSE the mask failed.
    const env = new Float32Array(100);
    for (let i = 0; i < 100; i++) env[i] = 0.3; // bleed: never stops
    for (let i = 20; i < 40; i++) env[i] = 1.0; // the singing
    for (let i = 70; i < 85; i++) env[i] = 0.95;
    const m = maskFromEnergy(env);
    expect(voicedFraction(m)).toBeLessThan(0.5); // NOT all ones
    expect(m[0]).toBe(0); // bleed is not singing
    expect(m[25]).toBe(1); // singing is
    expect(m[75]).toBe(1);
  });

  it("★ and it still works on a CLEAN stem, where the floor really is silence", () => {
    const env = new Float32Array(100);
    for (let i = 20; i < 40; i++) env[i] = 1.0;
    const m = maskFromEnergy(env);
    expect(voicedFraction(m)).toBeCloseTo(0.2, 1);
    expect(m[0]).toBe(0);
    expect(m[30]).toBe(1);
  });

  it("★ a stem with NO dynamic range finds no singing, rather than claiming all of it", () => {
    // Constant energy carries no information about where the voice is. The old peak-relative gate
    // would have called every frame voiced — the maximally confident wrong answer. Gating on the
    // stem's own distribution makes the floor and the voice the same number, so nothing clears it,
    // and the aligner falls back to the LRC's own line clock instead of fabricating word times.
    // Refusing is the honest failure; claiming everything is the dangerous one.
    expect(voicedFraction(maskFromEnergy(new Float32Array(100).fill(1)))).toBe(0);
    expect(voicedFraction(new Float32Array(100))).toBe(0);
  });
});

// ---- the whole machine, end to end, against ground truth --------------------------------
describe("alignLrc — LRC words + a vocal stem → word times", () => {
  const HOP = 0.05;
  const DUR = 60;

  // A vocal that sings 4 lines. Onsets are IRREGULAR on purpose: a metronome fixture is genuinely
  // ambiguous and would hide exactly the aliasing bug that bit us before.
  const TRUE_LINES = [
    { start: 8.0, text: "walking on a dream" },
    { start: 14.3, text: "how can I explain" },
    { start: 21.1, text: "touching on my mind" },
    { start: 27.6, text: "surely changing" },
  ];
  const spacings = [0.31, 0.44, 0.28, 0.52, 0.37];
  // Ground truth: each word STARTS on a real onset — and a singer hits a note per SYLLABLE, so a
  // two-syllable word ("walking") produces TWO attacks, the first of which is the word's start.
  // (The old fixture gave one onset per WORD, which no sung vocal does, and it hid the fact that the
  // seed must divide the attacks by syllables rather than by words.)
  const truthWords: { t: number; w: string; line: number }[] = [];
  const onsets: number[] = [];
  TRUE_LINES.forEach((l, li) => {
    let t = l.start;
    l.text.split(" ").forEach((w, wi) => {
      truthWords.push({ t: Number(t.toFixed(3)), w, line: li });
      const syl = syllables(w);
      for (let k = 0; k < syl; k++) {
        onsets.push(Number((t + k * 0.18).toFixed(3))); // the word's syllables, as separate notes
      }
      t += spacings[wi % spacings.length] + (syl - 1) * 0.18;
    });
  });
  // Some onsets that are NOT word starts (breaths, consonant transients) — the DP must not be
  // fooled into using them just because they exist.
  for (const extra of [9.9, 16.7, 23.4, 29.8, 40.0, 41.2]) onsets.push(extra);
  onsets.sort((a, b) => a - b);

  // The vocal stem's energy: loud where a line is being sung.
  const frames = Math.round(DUR / HOP);
  const env = new Float32Array(frames);
  TRUE_LINES.forEach((l) => {
    const end = l.start + l.text.split(" ").length * 0.4;
    for (let f = Math.round(l.start / HOP); f < Math.round(end / HOP); f++) env[f] = 1;
  });

  const lrcFrom = (shift: number): LyricsLine[] =>
    TRUE_LINES.map((l, i) => ({
      start: l.start + shift,
      end: (i + 1 < TRUE_LINES.length ? TRUE_LINES[i + 1].start : DUR - 20) + shift,
      text: l.text,
    }));

  const medianErr = (lines: LyricsLine[]): number => {
    const got = lines.flatMap((l) => l.words ?? []);
    const errs = got.map((w, i) => Math.abs(w.t - truthWords[i].t));
    const s = [...errs].sort((a, b) => a - b);
    return s[s.length >> 1];
  };

  it("★ every word lands on its real vocal onset when the LRC clock is already right", () => {
    const { lines, report } = alignLrc({ lines: lrcFrom(0), onsets, env, hop: HOP, duration: DUR });
    expect(report.applied).toBe(true);
    expect(medianErr(lines)).toBeLessThan(0.02);
    expect(report.words).toBe(truthWords.length);
  });

  it("★★ a 5-SECOND LRC offset is removed — the failure the old aligner could not even see", () => {
    // This is the real-world case: the upload has a different intro to whatever the LRC was timed
    // against. align.ts caps its search at 0.8 s, so on its own it would be hopeless here.
    const { lines, report } = alignLrc({ lines: lrcFrom(5), onsets, env, hop: HOP, duration: DUR });
    expect(report.offset).toBeCloseTo(-5, 0);
    expect(medianErr(lines)).toBeLessThan(0.05);
  });

  it("★ words never reorder, never share an onset, and every word survives", () => {
    const { lines } = alignLrc({ lines: lrcFrom(2.5), onsets, env, hop: HOP, duration: DUR });
    const ws = lines.flatMap((l) => l.words ?? []);
    expect(ws.length).toBe(truthWords.length); // alignment must never LOSE a word
    for (let i = 1; i < ws.length; i++) expect(ws[i].t).toBeGreaterThan(ws[i - 1].t);
  });

  it("lines are rebuilt from the aligned words, and the ribbon stays monotone", () => {
    const { lines } = alignLrc({ lines: lrcFrom(3), onsets, env, hop: HOP, duration: DUR });
    for (const l of lines) {
      expect(l.start).toBeCloseTo(l.words![0].t, 5);
      expect(l.end).toBeGreaterThan(l.start);
    }
    for (let i = 1; i < lines.length; i++) expect(lines[i].start).toBeGreaterThanOrEqual(lines[i - 1].end - 1e-6);
  });

  it("★ with NO onsets it passes the words through rather than inventing times", () => {
    const { lines, report } = alignLrc({ lines: lrcFrom(0), onsets: [], env, hop: HOP, duration: DUR });
    expect(report.applied).toBe(false);
    expect(lines.flatMap((l) => l.words ?? []).length).toBe(truthWords.length); // still usable, LRC-timed
  });
});

// ---- ★ THE RAMMSTEIN CASE — the bug the operator actually hit ---------------------------
describe("a line whose words are separated by INSTRUMENTAL BARS", () => {
  const HOP = 0.05;
  const DUR = 40;

  // "Du Hast": ONE LRC line — "Du, du hast, du hast mich" — sung across ~10 s with two bars of
  // guitar in the middle of it. Only ~3 of those 10 seconds contain any voice at all.
  //   "Du"              at 10.0
  //   "du hast"         at 13.5  (after 2 bars of guitar)
  //   "du hast mich"    at 17.0  (after 2 more)
  const BURSTS: { t: number; words: string[] }[] = [
    { t: 10.0, words: ["Du,"] },
    { t: 13.5, words: ["du", "hast,"] },
    { t: 17.0, words: ["du", "hast", "mich"] },
    // Line 2 is sung too — a fixture where an LRC line has NO vocal under it isn't a song, and it
    // let the coarse offset "improve" coverage by sliding the track 12.75 s onto the wrong phrase.
    { t: 30.0, words: ["Du", "hast", "mich", "gefragt"] },
  ];
  const truth: number[] = [];
  const onsets: number[] = [];
  const env = new Float32Array(Math.round(DUR / HOP));
  for (const b of BURSTS) {
    b.words.forEach((_, i) => {
      const t = Number((b.t + i * 0.42).toFixed(3));
      truth.push(t);
      onsets.push(t);
    });
    // Voice is present only for the burst — the bars between are SILENT on the vocal stem.
    const end = b.t + b.words.length * 0.42 + 0.25;
    for (let f = Math.round(b.t / HOP); f < Math.round(end / HOP); f++) env[f] = 1;
  }
  onsets.sort((a, b) => a - b);

  // What the LRC file actually gives you: one line, one timestamp, and the next line far away.
  const lines: LyricsLine[] = [
    { start: 10.0, end: 30.0, text: "Du, du hast, du hast mich" },
    { start: 30.0, end: DUR, text: "Du hast mich gefragt" },
  ];
  const LINE0 = 6; // words in line 0 — the ones we assert on

  it("★★ spreads the words over the VOICED time, not the wall time", () => {
    const { lines: out, report } = alignLrc({ lines, onsets, env, hop: HOP, duration: DUR });
    const ws = out[0].words!;
    expect(ws.map((w) => w.w)).toEqual(["Du,", "du", "hast,", "du", "hast", "mich"]);

    // THE BUG: seeding across the line's 20-second wall-clock span (or crushing it into a
    // syllable-rate 1.5 s) put nearly every word in a gap where no vocal onset exists — so the DP
    // declined them all and the whole line slid onto its last reachable onset ("mich"). Every word
    // must land within a few tens of ms of the note it belongs to.
    ws.forEach((w, i) => expect(Math.abs(w.t - truth[i])).toBeLessThan(0.06));
    expect(ws).toHaveLength(LINE0);

    // ...and it did so by SNAPPING to real onsets, not by luck.
    expect(report.snapped).toBeGreaterThanOrEqual(5);
  });

  it("★★★ THE HELD NOTE: a sustained 'Duuuu' buys seconds and is still ONE word", () => {
    // The bug the operator actually caught, and the one my first fixture was too kind to expose.
    // Till holds the opening "Du" for as long as the whole two-word phrase that follows it. So the
    // three bursts carry 1, 2 and 3 words but occupy roughly EQUAL voiced time.
    //
    // Seed the words across VOICED TIME and two of them land inside the held "Du" — every word after
    // that is a slot late, and the last one ("mich") ends up past the end of the singing entirely.
    // That is exactly what the ribbon showed. Time was never the right ruler.
    //
    // The ATTACKS have no such problem: a held note rings once however long it lasts. 1 + 2 + 3
    // attacks, 1 + 2 + 3 words.
    const DUR2 = 30;
    const held = [
      { t: 5.0, words: ["Du,"], sung: 2.2 }, // ONE word, held for 2.2 s
      { t: 9.0, words: ["du", "hast,"], sung: 1.0 },
      { t: 13.0, words: ["du", "hast", "mich"], sung: 1.4 },
    ];
    const truth2: number[] = [];
    const on2: number[] = [];
    const env2 = new Float32Array(Math.round(DUR2 / HOP));
    for (const b of held) {
      b.words.forEach((_, i) => {
        const t = Number((b.t + i * 0.45).toFixed(3));
        truth2.push(t);
        on2.push(t); // one attack per word — a held vowel does NOT re-attack
      });
      for (let f = Math.round(b.t / HOP); f < Math.round((b.t + b.sung) / HOP); f++) env2[f] = 1;
    }
    on2.sort((a, b) => a - b);
    const lrc2: LyricsLine[] = [{ start: 5.0, end: DUR2, text: "Du, du hast, du hast mich" }];

    const { lines: out2 } = alignLrc({ lines: lrc2, onsets: on2, env: env2, hop: HOP, duration: DUR2 });
    const ws = out2[0].words!;
    expect(ws.map((w) => w.w)).toEqual(["Du,", "du", "hast,", "du", "hast", "mich"]);
    ws.forEach((w, i) => expect(Math.abs(w.t - truth2[i])).toBeLessThan(0.06));
    // ...and in particular, the SECOND word is not swallowed by the first word's sustain.
    expect(ws[1].t).toBeGreaterThan(8.5);
  });

  it("★ the words do NOT pile up at the start of the line", () => {
    const ws = alignLrc({ lines, onsets, env, hop: HOP, duration: DUR }).lines[0].words!;
    // The last word is ~8 s after the first. A wall-clock or syllable-rate seed would have put them
    // all inside the first 1.5 s, which is precisely how the line collapsed onto one word.
    expect(ws[ws.length - 1].t - ws[0].t).toBeGreaterThan(6);
  });
});

// ---- ★ PLAIN lyrics: the right words, and NO clock at all -------------------------------
describe("alignPlain — forced alignment's home ground", () => {
  const HOP = 0.05;
  const DUR = 40;
  // Two sung phrases with a long instrumental break between them. LRCLIB has the words (6% of a real
  // library is like this — "Coax & Botany" is one) but nobody ever timed them.
  const PHRASES = [
    { t: 6.0, text: "hold me in the light" },
    { t: 24.0, text: "and let the summer go" },
  ];
  const truth: number[] = [];
  const onsets: number[] = [];
  const env = new Float32Array(Math.round(DUR / HOP));
  for (const p of PHRASES) {
    const ws = p.text.split(" ");
    ws.forEach((_, i) => {
      const t = Number((p.t + i * 0.5).toFixed(3));
      truth.push(t);
      onsets.push(t);
    });
    const end = p.t + ws.length * 0.5 + 0.3;
    for (let f = Math.round(p.t / HOP); f < Math.round(end / HOP); f++) env[f] = 1;
  }
  onsets.sort((a, b) => a - b);

  it("★ places un-timed words on the vocal — the instrumental break costs nothing", () => {
    const { lines, report } = alignPlain({
      text: PHRASES.map((p) => p.text),
      onsets,
      env,
      hop: HOP,
      duration: DUR,
    });
    expect(lines).toHaveLength(2);
    const ws = lines.flatMap((l) => l.words ?? []);
    expect(ws).toHaveLength(truth.length);
    ws.forEach((w, i) => expect(Math.abs(w.t - truth[i])).toBeLessThan(0.08));
    expect(report.applied).toBe(true);
  });

  it("★ reports ZERO confidence — there are no line anchors to check itself against", () => {
    // Saying "94%" here would be a number with nothing behind it. With no anchors, one missed
    // ad-lib shifts everything after it and nothing pulls it back. The UI must be able to say so.
    const { report } = alignPlain({ text: PHRASES.map((p) => p.text), onsets, env, hop: HOP, duration: DUR });
    expect(report.confidence).toBe(0);
  });

  it("a silent stem yields nothing rather than a guess", () => {
    const { lines } = alignPlain({ text: ["some words"], onsets: [], env: new Float32Array(800), hop: HOP, duration: DUR });
    expect(lines).toHaveLength(0);
  });
});
