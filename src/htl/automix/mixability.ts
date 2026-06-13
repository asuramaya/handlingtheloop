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
}

/** Overall mixability of B-after-A. Key weighted slightly above tempo (a harmonic
 *  clash is more jarring than a small tempo pull, which SYNC corrects anyway). */
export function mixability(a: TrackMeta, b: TrackMeta): Mixability {
  return {
    score: 0.55 * keyScore(a, b) + 0.45 * bpmScore(a, b),
    keyDistance: camelotDistance(a.key, b.key),
    bpmRatio: bpmRatioFolded(a.bpm, b.bpm),
  };
}

export type MixabilityTier = "high" | "mid" | "low";
export function mixabilityTier(score: number): MixabilityTier {
  return score >= 0.75 ? "high" : score >= 0.5 ? "mid" : "low";
}

/** Auto-adapt the transition to how compatible the pair is: a long harmonic blend
 *  when they sit well together, a quick EQ cut when they clash. The AutoMixer may
 *  upgrade `blend` → `stemswap` at mix time if both decks have stems. */
export function pickTransition(a: TrackMeta, b: TrackMeta): TransitionPlan {
  const { score, keyDistance } = mixability(a, b);
  const keyMatch = keyDistance == null ? true : keyDistance <= 2;
  if (score >= 0.75) return { style: "blend", bars: 24, bassSwapBar: 8, keyMatch, score };
  if (score >= 0.5) return { style: "blend", bars: 12, bassSwapBar: 4, keyMatch, score };
  return { style: "cut", bars: 4, bassSwapBar: 0, keyMatch: false, score };
}

/** Short human label for a transition badge in the queue UI. */
export function transitionLabel(p: TransitionPlan): string {
  if (p.style === "stemswap") return `Stem swap · ${p.bars}`;
  if (p.style === "cut") return "Quick cut";
  return `${p.keyMatch ? "Harmonic" : "Blend"} · ${p.bars} bar`;
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
