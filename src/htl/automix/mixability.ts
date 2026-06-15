import type { TrackMeta } from "../library/types";
import type { TransitionPlan } from "./types";

// How well does track B mix after track A? Pure functions over the metadata the
// app already stores on a TrackMeta (Camelot `key` + analyzed `bpm`). Used to
// rank radio candidates, smart-sort playlists, and pick a transition style.
//
// The Camelot math mirrors `harmonicDistance` in analysis/analyze.ts, but works on
// the stored Camelot STRINGS (e.g. "8A") rather than full KeyInfo objects, so the
// queue can score tracks without re-deriving key info. Runtime key-matching in the
// AutoMixer still goes through the engine's KeyInfo-based smartKeyShift.

function camelotParts(c: string): { num: number; major: boolean } {
  const s = c.trim().toUpperCase();
  return { num: parseInt(s, 10) || 0, major: s.endsWith("B") };
}

/** Camelot-wheel distance between two stored key codes. 0 = same, 1 = compatible
 *  (relative or a fifth away), ≥2 = increasingly dissonant. null if either key is
 *  missing/unparseable (unanalyzed track). */
export function camelotDistance(a: string | null | undefined, b: string | null | undefined): number | null {
  if (!a || !b) return null;
  const pa = camelotParts(a);
  const pb = camelotParts(b);
  if (!pa.num || !pb.num) return null;
  let dn = Math.abs(pa.num - pb.num);
  dn = Math.min(dn, 12 - dn); // circular on the 12-position ring
  if (pa.major === pb.major) return dn; // same ring
  return dn === 0 ? 1 : 1 + dn; // cross-ring: 0 = relative (compatible)
}

/** Tempo ratio b/a folded into [1/√2, √2] — i.e. octave-equivalent, matching the
 *  half/double folding the SYNC engine uses. 1 = identical tempo after folding.
 *  null if either BPM is missing. */
export function bpmRatioFolded(a: number | null | undefined, b: number | null | undefined): number | null {
  if (!a || !b || a <= 0 || b <= 0) return null;
  let r = b / a;
  while (r > Math.SQRT2) r /= 2;
  while (r < 1 / Math.SQRT2) r *= 2;
  return r;
}

function keyScore(a: TrackMeta, b: TrackMeta): number {
  const d = camelotDistance(a.key, b.key);
  if (d == null) return 0.5; // unknown → neutral, don't punish unanalyzed tracks
  return d === 0 ? 1 : d === 1 ? 0.82 : d === 2 ? 0.45 : 0.18;
}

function bpmScore(a: TrackMeta, b: TrackMeta): number {
  const r = bpmRatioFolded(a.bpm, b.bpm);
  if (r == null) return 0.5;
  // ~6 % tempo pull is comfortable, ~12 % is the edge of a clean beatmatch.
  return Math.max(0, 1 - Math.abs(r - 1) / 0.12);
}

export interface Mixability {
  score: number; // 0..1
  keyDistance: number | null;
  bpmRatio: number | null;
  keyKnown: boolean; // both tracks had a parseable key
  tempoKnown: boolean; // both tracks had a BPM
}

/** Overall mixability of B-after-A. Key weighted slightly above tempo (a harmonic
 *  clash is more jarring than a small tempo pull, which SYNC corrects anyway). */
export function mixability(a: TrackMeta, b: TrackMeta): Mixability {
  const keyDistance = camelotDistance(a.key, b.key);
  const bpmRatio = bpmRatioFolded(a.bpm, b.bpm);
  return {
    // Tempo continuity matters more for a flowing set than exact key, so weight BPM
    // a touch higher — keeps the energy/pace consistent instead of lurching.
    score: 0.45 * keyScore(a, b) + 0.55 * bpmScore(a, b),
    keyDistance,
    bpmRatio,
    keyKnown: keyDistance != null,
    tempoKnown: bpmRatio != null,
  };
}

export type MixabilityTier = "high" | "mid" | "low";
export function mixabilityTier(score: number): MixabilityTier {
  return score >= 0.75 ? "high" : score >= 0.5 ? "mid" : "low";
}

/** Badge colour tier for a planned transition — grey ("unknown") when we had no
 *  analysis to judge by, so the UI doesn't imply a confidence it doesn't have. */
export function planTier(p: TransitionPlan): MixabilityTier | "unknown" {
  return p.confident ? mixabilityTier(p.score) : "unknown";
}

/** A normalized "song identity" from a title — drops version/remix/feature/mashup
 *  markers so different uploads of the SAME song collapse to one key. Used to stop the
 *  queue from suggesting "Danza Kuduro → Danza Kuduro (Original Mix) → Danza Kuduro x …".
 *  This is song-level DEDUP (matching the song name in the title), not slop filtering. */
export function songCore(title: string): string {
  let s = (title || "").toLowerCase();
  s = s.replace(/\([^)]*\)/g, " ").replace(/\[[^\]]*\]/g, " "); // drop (…) and […]
  // Cut at the first remix/version/feature/mashup marker.
  s = s.replace(/\b(feat\.?|ft\.?|featuring|vs\.?|remix|mix|cover|version|mashup|edit|bootleg|live|acoustic|remaster(?:ed)?|official|lyrics?|audio|video)\b.*$/i, " ");
  s = s.replace(/\s+x\s+.*$/i, " "); // "Song x Other" mashup → keep the first song
  s = s.replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  return s;
}

/** Average mixability of a candidate against several seed tracks (both loaded
 *  decks) — how well it fits the current two-track context. */
export function avgMixability(seeds: TrackMeta[], track: TrackMeta): number {
  if (!seeds.length) return 0.5;
  return seeds.reduce((s, sd) => s + mixability(sd, track).score, 0) / seeds.length;
}

/** Auto-adapt the transition to how compatible the pair is: a long harmonic blend
 *  when they sit well together, a quick EQ cut when they clash. The AutoMixer may
 *  upgrade `blend` → `stemswap` at mix time if both decks have stems. */
export function pickTransition(a: TrackMeta, b: TrackMeta): TransitionPlan {
  const { score, keyDistance, keyKnown, tempoKnown } = mixability(a, b);
  const keyMatch = keyDistance == null ? true : keyDistance <= 2; // still attempt at runtime
  const confident = keyKnown || tempoKnown;
  // Pick the transition AND the DSP palette by how well the pair fits:
  //   high compat → long harmonic EQ3 blend (bass-swap, key+tempo locked)
  //   mid         → shorter EQ3 blend
  //   unknown/low → FILTER sweep: the cheap one-knob filter masks an unproven pair
  //                 and still rides tempo/key sync — sounds intentional, not a guess
  //   clash       → quick cut
  if (!confident) return { style: "filter", bars: 12, bassSwapBar: 4, keyMatch, score, keyKnown, confident };
  if (score >= 0.75) return { style: "blend", bars: 24, bassSwapBar: 8, keyMatch, score, keyKnown, confident };
  if (score >= 0.55) return { style: "blend", bars: 16, bassSwapBar: 6, keyMatch, score, keyKnown, confident };
  if (score >= 0.38) return { style: "filter", bars: 12, bassSwapBar: 4, keyMatch, score, keyKnown, confident };
  return { style: "cut", bars: 6, bassSwapBar: 0, keyMatch: false, score, keyKnown, confident };
}

/** Short human label for a transition badge in the queue UI. Only claims "Harmonic"
 *  when the key relationship is actually known and compatible. */
export function transitionLabel(p: TransitionPlan): string {
  // Compact: these sit in a narrow fixed-width "Mix" column, so no "· N bar" tail
  // (it spilled the cell). The full mixability % rides the badge's title tooltip.
  if (p.style === "stemswap") return `Stems ${p.bars}`;
  if (p.style === "cut") return "Cut";
  if (p.style === "filter") return `Filter ${p.bars}${p.confident ? "" : "?"}`;
  return `${p.keyKnown && p.keyMatch ? "Harmonic" : "Blend"} ${p.bars}`;
}

/** Rank candidate tracks by how well each mixes after `seed` (best first). Stable
 *  for equal scores (keeps the source order, i.e. YouTube relevance). */
export function rankByMixability(seed: TrackMeta, candidates: TrackMeta[]): TrackMeta[] {
  return candidates
    .map((track, i) => ({ track, i, score: mixability(seed, track).score }))
    .sort((x, y) => y.score - x.score || x.i - y.i)
    .map((r) => r.track);
}

/** Re-order a track list into a greedy nearest-mixability chain so each song
 *  flows into the next. Keeps the first track as the anchor. */
export function smartSortChain(tracks: TrackMeta[]): TrackMeta[] {
  if (tracks.length <= 2) return tracks.slice();
  const remaining = tracks.slice();
  const out: TrackMeta[] = [remaining.shift() as TrackMeta];
  while (remaining.length) {
    const last = out[out.length - 1];
    let bestI = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const s = mixability(last, remaining[i]).score;
      if (s > bestScore) {
        bestScore = s;
        bestI = i;
      }
    }
    out.push(remaining.splice(bestI, 1)[0]);
  }
  return out;
}
