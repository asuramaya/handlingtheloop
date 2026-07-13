// Reading the alignment measurement — pure, so it can be tested without a GPU.
//
// The point of this module: a diagnostic that only prints numbers makes a human do the inference,
// and the human will do it once and then stop looking. These rules turn the measurement into a
// VERDICT that names its own fix, so "the lyrics don't line up" resolves to exactly one of:
//
//   SEGMENT   — word timestamps never engaged; we're painting coarse whole-line cues. Nothing to
//               do with alignment quality. Fix the model/library, not the math.
//   OFFSET    — a constant lag. OURS. Shift every word by medianLag and it's done.
//   DRIFT     — lag grows with track time. OURS: a rate or chunk-offset bug. Exactly fixable.
//   SCATTER   — lag is centred but wild. The MODEL is guessing per word. No offset fixes this;
//               it needs real forced alignment (or a model that can actually do the job).
//   ALIGNED   — the words ARE on the vocals. If it still looks wrong, the bug is in the RENDER
//               (time base, playhead, grid), not in the transcript.
import type { LyricsDiag } from "./types";

export type LyricsVerdictKind = "segment" | "offset" | "drift" | "scatter" | "aligned" | "unknown";

export interface LyricsVerdict {
  kind: LyricsVerdictKind;
  headline: string;
  /** What to actually DO about it. */
  fix: string;
  /** true when the fault is ours (a pipeline bug) rather than the model's. */
  ours: boolean;
}

// Musical tolerances, not statistical ones. ~50 ms is tight, ~120 ms starts to read as "late",
// 250 ms+ is unmistakably wrong to anyone watching a word light up against a vocal.
const OFFSET_S = 0.12; // a median lag beyond this is a real, audible offset
const SCATTER_S = 0.25; // spread beyond this means the model is guessing, not merely offset
const DRIFT_MS_PER_MIN = 100; // 100 ms/min ≈ 0.4 s adrift by the end of a 4-minute track

export function lyricsVerdict(d: LyricsDiag): LyricsVerdict {
  if (d.mode === "segment") {
    return {
      kind: "segment",
      ours: false,
      headline: "Word timestamps never engaged — these are coarse SEGMENT cues",
      fix: d.wordError
        ? `The model refused word-level timestamps: ${d.wordError}. Use a _timestamped repo that really has alignment heads, or a library version that supports them.`
        : "The model produced no word-level timestamps. Whole lines light up on segment times, which looks exactly like bad alignment.",
    };
  }
  if (!d.words) {
    return { kind: "unknown", ours: false, headline: "No words decoded", fix: "Nothing was transcribed — check the vocal stem actually has vocals." };
  }
  if (!d.onsets || d.matched / d.words < 0.5) {
    return {
      kind: "unknown",
      ours: true,
      headline: `Only ${Math.round((d.matched / d.words) * 100)}% of words sit near ANY vocal onset`,
      fix: "Either the onset detector is failing on this stem, or the words are so far off that they fall outside the ±2 s search. Both are ours.",
    };
  }

  const drifting = Math.abs(d.driftMsPerMin) > DRIFT_MS_PER_MIN;
  const offset = Math.abs(d.medianLag) > OFFSET_S;
  const scattered = d.madLag > SCATTER_S;

  // Drift first: it SUBSUMES an apparent offset (a drifting error has a non-zero median too), and
  // it's the more specific — and more fixable — diagnosis of the two.
  if (drifting) {
    return {
      kind: "drift",
      ours: true,
      headline: `Lag GROWS with the track — ${d.driftMsPerMin.toFixed(0)} ms per minute`,
      fix: "A rate or chunk-offset bug in OUR pipeline (resample ratio, or the per-chunk time offset). The words start right and walk away. Exactly fixable — no model change will help.",
    };
  }
  if (offset && !scattered) {
    return {
      kind: "offset",
      ours: true,
      headline: `Constant offset — every word lands ${(d.medianLag * 1000).toFixed(0)} ms ${d.medianLag > 0 ? "EARLY" : "LATE"}`,
      fix: `A fixed pipeline offset. Shift every word by ${(d.medianLag * 1000).toFixed(0)} ms and it's done. Note the shipped ±160 ms snap can only reach ${Math.round(d.within160 * 100)}% of these words — which is why it isn't fixing it.`,
    };
  }
  if (scattered) {
    return {
      kind: "scatter",
      ours: false,
      headline: `Lag is centred (${(d.medianLag * 1000).toFixed(0)} ms) but WILD — spread ±${(d.madLag * 1000).toFixed(0)} ms`,
      fix: "The model is guessing each word's time; there is no single offset to remove. Needs real forced alignment against the vocal onsets (monotonic DTW), or a model that can actually time sung vocals.",
    };
  }
  return {
    kind: "aligned",
    ours: false,
    headline: `Words ARE on the vocals — median ${(d.medianLag * 1000).toFixed(0)} ms, spread ±${(d.madLag * 1000).toFixed(0)} ms`,
    fix: "The transcript is aligned to the stem. If the ribbon still looks wrong, the bug is in the RENDER — the caption time base, the playhead, or the grid — not in the lyrics.",
  };
}

/** The Debug ▸ Lyrics rows. Ordered so the verdict reads first and the evidence backs it up. */
export function formatLyricsDiag(d: LyricsDiag): [string, string][] {
  const v = lyricsVerdict(d);
  const ms = (s: number) => `${(s * 1000).toFixed(0)} ms`;
  const a = d.align;
  return [
    ["verdict (raw model)", `${v.kind.toUpperCase()} — ${v.headline}`],
    ["fix", v.fix],
    ["fault", v.ours ? "OURS (pipeline)" : v.kind === "aligned" ? "none" : "model / library"],
    ["mode", d.mode === "word" ? "word timestamps ✓" : `SEGMENT fallback${d.wordError ? ` (${d.wordError})` : ""}`],
    // ── what the raw model gave us ──
    ["model offset", ms(d.medianLag)],
    ["model drift", `${d.driftMsPerMin.toFixed(0)} ms/min`],
    ["model scatter (MAD)", `±${ms(d.madLag)}`],
    ["words / matched", `${d.words} / ${d.matched}`],
    ["vocal onsets", String(d.onsets)],
    ["old ±160ms snap", `could reach ${Math.round(d.within160 * 100)}% of words`],
    // ── what WE did about it ──
    [
      "ALIGNER",
      a
        ? a.applied
          ? `removed ${ms(a.bias)} offset + ${(a.drift * 60 * 1000).toFixed(0)} ms/min drift · ${a.snapped}/${a.snapped + a.free} words placed on a real vocal onset · moved a word by ${ms(a.medianMove)} typically`
          : "DECLINED — could not justify a correction, times left untouched"
        : "did not run (segment mode / no words)",
    ],
    ["model", d.model],
    ["ran as", d.dtype],
    ["transformers.js", d.tjs ?? "?"],
    ["decode", `${(d.decodeMs / 1000).toFixed(1)} s`],
  ];
}
