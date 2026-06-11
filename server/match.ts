// Track matching for cross-service sync. The ISRC asymmetry (Spotify exposes it,
// YouTube search can't query it) means matching is fuzzy: normalized title/artist
// token overlap + a duration check + a penalty for live/remix/cover variants the
// source didn't ask for. Returns a confidence tier so the UI can flag weak
// matches for manual review (the SongShift/FreeYourMusic pattern).

export type Confidence = "high" | "medium" | "low" | "none";

export interface Candidate {
  id: string; // youtube videoId, or spotify track uri
  kind: "video" | "uri";
  title: string;
  artist: string;
  duration: number; // seconds (0 if unknown)
  thumbnail: string | null;
}

// Noise words that shouldn't drive a match.
const NOISE = /\b(official|video|audio|lyrics?|hd|hq|mv|m\/v|visuali[sz]er|remaster(?:ed)?|feat\.?|ft\.?|prod\.?)\b/gi;
// Variant markers — if the candidate has one the source lacks, it's probably the wrong version.
const VARIANT = /\b(live|remix|cover|acoustic|instrumental|karaoke|sped\s?up|slowed|reverb|8d|nightcore|edit|mix|version|demo)\b/gi;

function normalize(s: string): string {
  return (s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip diacritics
    .replace(/\([^)]*\)/g, " ")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(NOISE, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(s: string): Set<string> {
  return new Set(normalize(s).split(" ").filter(Boolean));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

function variants(s: string): Set<string> {
  const out = new Set<string>();
  for (const m of (s || "").toLowerCase().matchAll(VARIANT)) out.add(m[0].replace(/\s+/g, ""));
  return out;
}

export interface ScoreInput {
  title: string;
  artist: string;
  duration: number;
}

/** Score a candidate against the source track in [0,1]. */
export function score(src: ScoreInput, cand: ScoreInput): number {
  const titleScore = jaccard(tokens(src.title), tokens(cand.title));
  // Artist tokens are noisy (YouTube channel vs Spotify artist); weight title more.
  const artistScore = jaccard(tokens(src.artist), tokens(cand.artist));
  let s = 0.65 * titleScore + 0.35 * artistScore;

  // Duration agreement (only when both known).
  if (src.duration > 0 && cand.duration > 0) {
    const dd = Math.abs(src.duration - cand.duration);
    const durFactor = Math.max(0, 1 - dd / 20); // 0s→1, 20s+→0
    s = s * (0.7 + 0.3 * durFactor);
  }

  // Penalize a variant the source didn't ask for (live/remix/cover/…).
  const srcV = variants(src.title);
  const candV = variants(cand.title);
  for (const v of candV) if (!srcV.has(v)) s *= 0.6;

  return Math.max(0, Math.min(1, s));
}

export function confidenceOf(s: number): Confidence {
  if (s >= 0.7) return "high";
  if (s >= 0.45) return "medium";
  if (s >= 0.25) return "low";
  return "none";
}

/** Rank candidates against the source; return them sorted best-first with scores. */
export function rank(src: ScoreInput, candidates: Candidate[]): { cand: Candidate; score: number }[] {
  return candidates
    .map((cand) => ({ cand, score: score(src, cand) }))
    .sort((a, b) => b.score - a.score);
}
