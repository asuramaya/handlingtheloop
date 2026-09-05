import type { TrackMeta } from "../library/types";
import { camelotDistance, bpmRatioFolded, songCore } from "./mixability";
import type { EnergyArc, RadioContext } from "./types";

// THE SELECTOR — how the radio decides which candidate plays next.
//
// ★ WHY THIS IS NOT `mixability.ts`. Those two modules answer different questions and were
// conflated, which is most of why AUTO's picks felt random:
//
//   mixability(a, b)  = "if these two play back to back, how well do they MEET?"  → drives the
//                       transition planner (bars, bass-swap point, blend vs cut) and the UI badge.
//   scoreCandidate()  = "given everything about this moment, SHOULD this be next?" → drives the pick.
//
// The old code used the first for the second, and inherited its most important property as a bug:
// `mixability` deliberately returns a NEUTRAL 0.5 for an unknown key or tempo, because an
// unanalyzed track should not be punished when you are only describing a transition. But when you
// are RANKING, "I don't know" is not the same as "it's a 50/50 fit" — and since fresh radio
// candidates essentially never carry analysis, that neutral score was a constant across the whole
// pool, the harmonic term cancelled out, and the ranking silently collapsed to raw provider order.
//
// Here, unknown is its own state: it contributes nothing and forfeits the analysed bonus. An
// unanalyzed track can still win on relatedness alone, but a track the prefetcher has actually
// done work on wins the tie — which is exactly the behaviour you want, because it pulls the queue
// toward tracks we can beatmatch properly.

/** A track under consideration, with the provider signal that put it there. */
export interface Candidate {
  track: TrackMeta;
  /** Provider relatedness, 0..1 — how strongly the radio graph associated it with the seed. */
  rel: number;
  /** videoId of the seed whose radio produced it. Diagnostics only. */
  from: string;
  /** When it entered the pool (ms) — used only to age out stale candidates. */
  at: number;
}

/** The decomposed score. Emitted to the trace log on every pick, so the weights below can be
 *  tuned against what actually happened rather than by feel. */
export interface ScoreParts {
  rel: number;
  key: number;
  bpm: number;
  energy: number;
  analysed: number;
  artistPenalty: number;
  repeatPenalty: number;
  total: number;
}

// Weights. The provider graph stays the backbone — it is the only term that knows a Fishmans
// track should not be followed by Jeezy — but it no longer decides alone.
const W_REL = 0.42;
const W_KEY = 0.16;
const W_BPM = 0.18;
const W_ENERGY = 0.12;
const W_ANALYSED = 0.06; // a small, deliberate thumb on the scale for tracks we can actually mix

// Artist cooldown. THE single cheapest fix for "it keeps playing the same stuff": a YouTube
// watch-next feed for any seed is dominated by that artist's own catalogue, and nothing used to
// stop five of them in a row. Distance is measured over the upcoming queue AND the play history,
// so it also refuses to QUEUE two of an artist adjacently, not just to play them.
const ARTIST_HARD = 2; // within this many tracks → effectively disqualified
const ARTIST_SOFT = 7; // fading penalty out to here
const P_ARTIST = 1.0; // full penalty is larger than any achievable score → a hard block
const P_REPEAT = 0.5; // a track played earlier in the session, resurfacing too soon

/** Normalised artist identity. YouTube's "artist" is a channel name, so the same act arrives as
 *  "Burial", "Burial - Topic", "BurialVEVO" and "Burial Official" — all one artist for cooldown
 *  purposes, and treating them as four is how the same act got played four times in a row. */
export function artistKey(artist: string | null | undefined): string {
  let s = (artist || "").toLowerCase();
  s = s.replace(/\s*-\s*topic\s*$/, " ");
  s = s.replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  // Channel decorations, stripped from the END and NOT required to be their own word — YouTube
  // writes both "Burial Official" and "BurialVEVO", and a \b-anchored match silently misses the
  // second, which is exactly the case that lets one act through the cooldown twice. Looped,
  // because they stack ("Artist Official Music").
  for (let i = 0; i < 3; i++) {
    const next = s.replace(/\s*(vevo|official|officiel|music|records|recordings|channel|tv|hd)\s*$/, "").trim();
    if (next === s) break;
    s = next;
  }
  return s;
}

/** Normalised words of a title, for looking an artist or a song name up INSIDE it. */
function titleWords(title: string): string {
  return ` ${(title || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim()} `;
}

/** Does `key` (an artistKey or songCore) appear as a whole phrase inside `title`? Only for keys
 *  long enough not to collide by accident — a two-letter channel name matches everything. */
function mentions(title: string, key: string): boolean {
  return key.length >= 6 && titleWords(title).includes(` ${key} `);
}

/** How much to hold this artist back, 0..1, given how recently they appeared. `nearby` is
 *  ordered by distance from now (upcoming queue first, then history most-recent-first).
 *
 *  ★ THE UPLOADER IS NOT THE ARTIST. Matching channel names alone missed the cases that matter
 *  most, because a cover, a tribute or a fan re-upload carries the artist's name in the TITLE while
 *  the channel says "Nb Music" or "triple j". Observed live: "Teardrop" was followed by "Massive
 *  Attack - Dissolved Girl (cover by Nb Music)" and "AURORA covers Massive Attack 'Teardrop'",
 *  neither of which the channel comparison could see. So a nearby track's artist counts as present
 *  if it is named in the candidate's title too. */
export function artistPenalty(cand: TrackMeta, nearby: readonly TrackMeta[]): number {
  const k = artistKey(cand.artist);
  const i = nearby.findIndex((t) => {
    const nk = artistKey(t.artist);
    if (!nk) return false;
    if (k && nk === k) return true; // same channel
    return mentions(cand.title, nk); // …or that artist is named in this candidate's title
  });
  if (i < 0) return 0;
  if (i < ARTIST_HARD) return 1;
  if (i < ARTIST_SOFT) return 1 - (i - ARTIST_HARD) / (ARTIST_SOFT - ARTIST_HARD);
  return 0;
}

/** Harmonic fit, and whether we actually knew. `known: false` means BOTH tracks' keys weren't
 *  parseable — it is NOT a middling score, and the caller must not treat it as one. */
export function keyFit(a: TrackMeta, b: TrackMeta): { v: number; known: boolean } {
  const d = camelotDistance(a.key, b.key);
  if (d == null) return { v: 0, known: false };
  return { v: d === 0 ? 1 : d === 1 ? 0.85 : d === 2 ? 0.4 : 0.1, known: true };
}

/** Tempo fit (octave-folded, so 140 after 70 is a match), and whether we knew. */
export function bpmFit(a: TrackMeta, b: TrackMeta): { v: number; known: boolean } {
  const r = bpmRatioFolded(a.bpm, b.bpm);
  if (r == null) return { v: 0, known: false };
  // ~12 % folded tempo difference is the edge of a clean beatmatch.
  return { v: Math.max(0, 1 - Math.abs(r - 1) / 0.12), known: true };
}

/** Where the arc wants energy to be for the NEXT track, given the current level and how many
 *  tracks AUTO has played. This is the difference between a playlist and a set.
 *   • ride    — hold the level the user established (the safe default).
 *   • build   — climb steadily, then release at the top and climb again.
 *   • journey — a slow swell and ebb over roughly ten tracks. */
export function targetEnergy(arc: EnergyArc, current: number, played: number): number {
  if (arc === "build") {
    const climb = (played % 10) / 10; // 0 → 0.9 then release
    return clamp01(Math.max(current, 0.35) + climb * 0.45 - (played % 10 === 0 ? 0.35 : 0));
  }
  if (arc === "journey") return clamp01(0.5 + 0.32 * Math.sin((played / 10) * Math.PI * 2));
  return clamp01(current); // ride
}

/** Energy fit against the arc's target, and whether the candidate was analysed for it. */
export function energyFit(cand: TrackMeta, target: number): { v: number; known: boolean } {
  const e = cand.energy;
  if (e == null || !Number.isFinite(e)) return { v: 0, known: false };
  // ±0.15 is "the same room"; beyond ~0.4 apart it is a different party.
  return { v: Math.max(0, 1 - Math.abs(e - target) / 0.4), known: true };
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export interface ScoreOpts {
  /** Upcoming queue then recent history, ordered by distance from now — the artist/repeat window. */
  nearby: readonly TrackMeta[];
  /** videoIds played this session, for the resurfacing penalty (exclusion is done by the caller). */
  playedRecently: readonly string[];
  /** Energy the arc wants next. */
  target: number;
}

/** Score one candidate to follow `prev`. Returns the decomposition, not just a number, because
 *  a single opaque float is untunable — the trace log carries every term. */
export function scoreCandidate(c: Candidate, prev: TrackMeta | null, opts: ScoreOpts): ScoreParts {
  const k = prev ? keyFit(prev, c.track) : { v: 0, known: false };
  const b = prev ? bpmFit(prev, c.track) : { v: 0, known: false };
  const e = energyFit(c.track, opts.target);

  const rel = W_REL * clamp01(c.rel);
  const key = W_KEY * k.v;
  const bpm = W_BPM * b.v;
  const energy = W_ENERGY * e.v;
  // The bonus is for being KNOWN, not for being good — a track we've analysed and found a poor
  // match still beats one we know nothing about at the same relatedness, because at least the
  // transition planner can pick an honest style for it.
  const analysed = W_ANALYSED * ((k.known ? 0.5 : 0) + (b.known ? 0.5 : 0));

  const artistPen = P_ARTIST * artistPenalty(c.track, opts.nearby);
  const ri = opts.playedRecently.indexOf(c.track.videoId);
  const repeatPen = ri < 0 ? 0 : P_REPEAT * (1 - Math.min(1, ri / Math.max(1, opts.playedRecently.length)));

  return {
    rel,
    key,
    bpm,
    energy,
    analysed,
    artistPenalty: artistPen,
    repeatPenalty: repeatPen,
    total: rel + key + bpm + energy + analysed - artistPen - repeatPen,
  };
}

/** Rank a pool and return the best candidate with its decomposition. Ties break toward the
 *  stronger provider signal, then toward the older pool entry (so a candidate that has been
 *  waiting — and has therefore had the most time to be analysed by the prefetcher — goes first). */
export function pickBest(
  pool: readonly Candidate[],
  prev: TrackMeta | null,
  opts: ScoreOpts,
): { candidate: Candidate; parts: ScoreParts } | null {
  let best: { candidate: Candidate; parts: ScoreParts } | null = null;
  for (const c of pool) {
    const parts = scoreCandidate(c, prev, opts);
    if (
      !best ||
      parts.total > best.parts.total ||
      (parts.total === best.parts.total && (c.rel > best.candidate.rel || (c.rel === best.candidate.rel && c.at < best.candidate.at)))
    ) {
      best = { candidate: c, parts };
    }
  }
  return best;
}

/** The seeds a fill should draw provider radio from, with the weight each one's results carry.
 *
 *  ★ THIS IS THE FIX FOR THE REPETITION. The old scheme seeded from the last three plays — a
 *  window that slid by one every song, so two of three seeds were always unchanged and the
 *  candidate pools overlapped about two-thirds. Worse, results were aggregated by SUMMING
 *  relatedness across seeds, which explicitly promoted the tracks common to all three radios:
 *  song after song, the same small overlap core floated to the top. The feature amplified its
 *  own repetition by design.
 *
 *  Now there are two stable seeds — the vibe ANCHOR the user set, and what is CURRENTLY playing —
 *  and the caller takes a MAX across their lists rather than a sum, so appearing in both is not
 *  a bonus. The anchor decays as the set moves away from it: the record you put on eight tracks
 *  ago should still colour the room, but it should not still be choosing the music. */
export function radioSeeds(ctx: RadioContext, manual: TrackMeta | null): { track: TrackMeta; weight: number }[] {
  const out: { track: TrackMeta; weight: number }[] = [];
  const seen = new Set<string>();
  const push = (t: TrackMeta | null, weight: number) => {
    if (!t?.videoId || seen.has(t.videoId) || weight <= 0) return;
    seen.add(t.videoId);
    out.push({ track: t, weight });
  };
  // A track the user explicitly queued next IS the vibe, at full strength, until it plays.
  push(manual, 1);
  push(ctx.current, 1);
  push(ctx.anchor, anchorWeight(ctx.anchorAge));
  return out;
}

/** How much the original vibe anchor still counts, by how many tracks have played since it was
 *  set. Floors at 0.25: never zero (the set should not forget where it started), never dominant. */
export function anchorWeight(age: number): number {
  return Math.max(0.25, 1 - Math.max(0, age) / 8);
}

/** Reject a candidate outright, before scoring: already played, already queued, currently on a
 *  deck, or just another upload of a song we already know about. Song-level identity uses
 *  `songCore`, so "Danza Kuduro" cannot come back as "Danza Kuduro (Original Mix)". */
export function isEligible(
  t: TrackMeta,
  bans: { played: ReadonlySet<string>; ids: ReadonlySet<string>; cores: ReadonlySet<string> },
): boolean {
  if (!t.videoId) return false;
  if (bans.played.has(t.videoId) || bans.ids.has(t.videoId)) return false;
  const core = songCore(t.title);
  if (core && bans.cores.has(core)) return false;
  // ★ AND THE SONG NAMED ANYWHERE IN THE TITLE, not just at its head. songCore normalises a title
  // to one key, which catches re-uploads and remixes but not a title built around a sentence:
  // "AURORA covers Massive Attack 'Teardrop' for Like A Version" reduces to nothing resembling
  // "teardrop", so the radio queued a cover of the record that was playing. Long keys only, so
  // this cannot fire on a common one-word title.
  for (const banned of bans.cores) {
    if (mentions(t.title, banned)) return false;
  }
  return true;
}
