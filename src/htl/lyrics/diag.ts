import type { LyricsDiag } from "./types";

// Settings ▸ Debug ▸ Lyrics. The point of this file: the pipeline has FIVE links, and a silent
// failure at any one of them looks identical from the outside ("no lyrics"). So report each link in
// order, and the first empty one IS the diagnosis:
//
//   identify → look up → line clock → vocal stem → align
//
// ★ AND DO NOT GRADE THE ALIGNER BY DISTANCE-TO-NEAREST-ONSET. It snaps words to onsets, so that
// number is ~0 by construction — an instrument pointed at the part we're proud of. An earlier
// version of this file did exactly that, and worse, it ALIASED: it could not see an offset larger
// than half the onset spacing, so it would have pronounced a badly misaligned track healthy. What we
// report is what the aligner DID. The ear is the acceptance test.

/** One verdict on the whole chain: which link failed, and what to do about it. */
export interface LyricsVerdict {
  kind:
    | "no-identity"
    | "lookup-failed"
    | "no-match"
    | "instrumental"
    | "no-stem"
    | "leaky-stem"
    | "plain-only"
    | "estimated"
    | "low-confidence"
    | "aligned"
    | "unknown";
  headline: string;
  fix: string;
}

/** Below this share of lines landing on real singing, the LRC probably describes a different
 *  rendering of the song (a live take, a different edit) and its clock is not ours. */
const LOW_CONF = 0.4;
/** Above this share of the track called "voiced", the stem is LEAKY — guitar and drum bleed sit above
 *  the gate — and every number measured against that mask is worthless, however good it looks. This
 *  is the check that catches a metric which has stopped measuring: Rammstein's stem reported 97%
 *  confidence precisely BECAUSE its mask had failed to ones. */
const LEAKY_STEM = 0.85;

export function lyricsVerdict(d: LyricsDiag): LyricsVerdict {
  if (!d.artist || !d.title)
    return {
      kind: "no-identity",
      headline: "NOT IDENTIFIED — we don't know what song this is",
      fix: "No fingerprint match, and the title didn't parse as 'Artist - Title'.",
    };
  if (d.lookupFailed)
    return {
      kind: "lookup-failed",
      headline: `LOOKUP FAILED · ${d.artist} — ${d.title}`,
      fix: "LRCLIB didn't respond in time — not necessarily a miss. ↻ Re-fetch.",
    };
  if (!d.matched)
    return {
      kind: "no-match",
      headline: `NO LYRICS FOUND · ${d.artist} — ${d.title}`,
      fix: "LRCLIB has never seen this recording. Falling back to YouTube captions.",
    };
  if (d.instrumental)
    return {
      kind: "instrumental",
      headline: "INSTRUMENTAL — this recording has no vocals",
      fix: "",
    };
  if (d.source === "lrclib")
    return {
      kind: "no-stem",
      headline: `LINE-SYNCED · ${d.lines} lines — but no vocal stem to time the WORDS against`,
      fix: "Turn on stem separation for word-level timing.",
    };
  if (d.plainOnly && d.source !== "estimated")
    return {
      kind: "plain-only",
      headline: `PLAIN LYRICS ONLY · ${d.lines} lines, no line clock`,
      fix: "No line clock on LRCLIB. Turn on stem separation to derive timing from the vocal.",
    };
  if (d.source === "estimated")
    return {
      kind: "estimated",
      headline: `TIMING ESTIMATED · ${d.snapped}/${d.words} words on a real vocal onset`,
      fix: "No line anchors — the whole timing comes from the vocal alone.",
    };
  if (d.onsets > 0 && d.voiced >= LEAKY_STEM)
    return {
      kind: "leaky-stem",
      headline: `LEAKY VOCAL STEM — ${Math.round(d.voiced * 100)}% of the track reads as "singing"`,
      fix: "No silence to measure against — offset/confidence below are meaningless. Try Hi-Fi separation, or re-analyze.",
    };
  if (d.confidence < LOW_CONF)
    return {
      kind: "low-confidence",
      headline: `LOW CONFIDENCE — only ${Math.round(d.confidence * 100)}% of lines landed on singing`,
      fix: "Likely a different edit (live take, remix). Offset not applied.",
    };
  if (d.applied)
    return {
      kind: "aligned",
      headline: `ALIGNED · ${d.snapped}/${d.words} words on a real vocal onset`,
      fix: "",
    };
  return {
    kind: "unknown",
    headline: "NOT ALIGNED — too few onsets in the vocal stem to work with",
    fix: "Showing LRCLIB's own line timings.",
  };
}

const ms = (x: number) => `${x >= 0 ? "+" : ""}${Math.round(x * 1000)} ms`;

export function formatLyricsDiag(d: LyricsDiag): [string, string][] {
  const v = lyricsVerdict(d);
  return [
    ["verdict", v.headline],
    ...(v.fix ? ([["fix", v.fix]] as [string, string][]) : []),
    // The chain, in order. The first blank row is the step that broke.
    ["1 · identity", d.artist && d.title ? `${d.artist} — ${d.title}` : "— not identified"],
    [
      "2 · LRCLIB",
      d.matched
        ? d.instrumental
          ? "instrumental (no vocals)"
          : `${d.lines} lines${d.plainOnly ? " · PLAIN ONLY (no line clock)" : ""}${d.words ? `, ${d.words} words` : ""}`
        : d.lookupFailed
          ? "— LOOKUP FAILED (timed out; not a miss)"
          : "— no match",
    ],
    ["3 · vocal stem", d.onsets ? `${d.onsets} onsets measured` : "— none (separation off, or no stem yet)"],
    [
      "3b · voiced",
      d.onsets
        ? `${Math.round(d.voiced * 100)}% of the track${d.voiced >= LEAKY_STEM ? " — ⚠ LEAKY, everything below is meaningless" : ""}`
        : "—",
    ],
    ["4 · offset", d.onsets ? `${ms(d.offset)} · ${Math.round(d.confidence * 100)}% of lines on singing` : "—"],
    [
      "5 · align",
      d.applied
        ? `${d.snapped} on an onset, ${d.free} held/legato${d.bias ? ` · residual ${ms(d.bias)}` : ""}${
            d.drift ? ` · drift ${(d.drift * 6e4).toFixed(0)} ms/min` : ""
          }`
        : "— DECLINED (nothing to align against)",
    ],
    ["source", d.source],
    ["took", `${(d.ms / 1000).toFixed(1)} s`],
  ];
}
