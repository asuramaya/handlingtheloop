import type { TrackMeta } from "../library/types";
import type { EnergyArc, StyleCapabilities, TransitionPlan, TransitionStyle } from "./types";

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
// Cut a title at the first remix/version/feature/mashup marker and reduce it to bare words.
function coreOf(s: string): string {
  return s
    .replace(/\b(feat\.?|ft\.?|featuring|vs\.?|remix|mix|cover|version|mashup|edit|bootleg|live|acoustic|remaster(?:ed)?|official|lyrics?|audio|video)\b.*$/i, " ")
    .replace(/\s+x\s+.*$/i, " ") // "Song x Other" mashup → keep the first song
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function songCore(title: string): string {
  let s = (title || "").toLowerCase();
  s = s.replace(/\([^)]*\)/g, " ").replace(/\[[^\]]*\]/g, " "); // drop (…) and […]

  // ★ SEE THROUGH A LEADING "ARTIST - " PREFIX. Without this the dedup failed on the single most
  // embarrassing case there is: the seed track coming straight back. YouTube is wildly
  // inconsistent about the prefix — a "- Topic" channel uploads "Teardrop (Remastered 2019)" while
  // every other upload of the same recording is "Massive Attack - Teardrop (Live in Berlin)".
  // Different keys, so the radio followed Teardrop with Teardrop, then with a Teardrop cover.
  //
  // But "X - Y" is genuinely ambiguous: "Massive Attack - Teardrop" is artist-then-song, while
  // "Danza Kuduro - Official Video" is song-then-junk. Guessing wrong either way loses the song
  // name. So take the half that SURVIVES the marker cut: in the first case the tail is a real
  // title ("teardrop"), in the second it is pure junk and reduces to nothing, which is the signal
  // that the song name was on the left all along.
  const dash = s.match(/^\s*[^-–—]{1,40}\s[-–—]\s(.+)$/);
  if (dash) {
    const tail = coreOf(dash[1]);
    if (tail.length >= 3) return tail;
  }
  return coreOf(s);
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
  if (p.style === "spinOut") return "Spin";
  if (p.style === "echoOut") return `Echo ${p.bars}`;
  if (p.style === "washOut") return `Wash ${p.bars}`;
  if (p.style === "gateChop") return "Gate";
  if (p.style === "loopChop") return "Chop";
  if (p.style === "dropSwap") return "Drop";
  if (p.style === "filter") return `Filter ${p.bars}${p.confident ? "" : "?"}`;
  return `${p.keyKnown && p.keyMatch ? "Harmonic" : "Blend"} ${p.bars}`;
}

// ── the transition vocabulary ───────────────────────────────────────────────────────────────────
// `pickTransition` above answers "how well do these two meet", and proposes a style from that
// alone. `resolveStyle` answers the different question the mixer actually faces at mix time:
// GIVEN what this pair needs, what the decks can currently do, and what I did LAST time — what
// should this transition be?
//
// The last-style memory is the point. A DJ who has three good options does not pick the same one
// four times running, and the previous mixer had no way to express that because it had only one
// gesture to begin with. Variety is only taken when it is nearly free: an alternative has to be
// genuinely suitable for this pair, never merely different.

/** Styles that suit a given compatibility score, best first. Not filtered by capability yet. */
function stylePreference(score: number, confident: boolean): TransitionStyle[] {
  // Each row is ordered best-first for that compatibility band, and each is DEEP — the
  // anti-repetition rule below can only avoid repeating itself if there is somewhere to go, and a
  // two-entry row means every other transition is the same one.
  if (!confident) return ["filter", "washOut", "echoOut", "blend"]; // unproven — mask it, don't commit
  if (score >= 0.75) return ["stemswap", "blend", "echoOut", "washOut", "loopChop"]; // they fit — go long
  if (score >= 0.55) return ["blend", "echoOut", "loopChop", "washOut", "filter"];
  if (score >= 0.38) return ["filter", "washOut", "loopChop", "gateChop", "echoOut"];
  // A clash. Don't blend it — make the change deliberate and let the effects carry it.
  return ["gateChop", "loopChop", "dropSwap", "spinOut", "cut"];
}

/** Is this style possible right now? */
function styleAvailable(style: TransitionStyle, caps: StyleCapabilities): boolean {
  switch (style) {
    case "stemswap":
      return caps.stems; // the only gesture that needs separation
    case "echoOut":
    case "washOut":
      return caps.fx;
    case "gateChop":
      return caps.fx && caps.grid; // a gate off the grid is noise, not a rhythm
    case "loopChop":
      return caps.grid; // pure loop + filter — no FX device at all
    case "dropSwap":
      return caps.incomingBody && caps.grid;
    case "spinOut":
      return caps.grid;
    default:
      return true; // blend / filter / cut need nothing beyond two decks
  }
}

// ── THE SHAPE OF THE SET ───────────────────────────────────────────────────────────────────────
//
// `stylePreference` answers "do these two records fit", which is a question about the PAIR. It has
// no idea whether the set is climbing, holding, or wandering — so a build and a wind-down with the
// same compatibility score got the identical gesture. The arc already exists and already picks the
// TRACKS (targetEnergy, in selector.ts); it just never had a say in how they were joined.
//
// A gesture is not only a way to get from A to B, it is a statement about direction. A long blend
// says "nothing is changing"; a drop swap says "here we go". Choosing between them from the pair
// alone throws away the one thing that makes a set feel authored.
//
// FORWARD gestures cut, mark, or arrive: they make the change an event.
const FORWARD: readonly TransitionStyle[] = ["dropSwap", "loopChop", "gateChop", "cut"];
// LONG gestures dissolve: they make the change something you notice afterwards.
const LONG: readonly TransitionStyle[] = ["blend", "stemswap", "washOut"];
// MASKING gestures hide the seam behind an effect — what you want when energy is dropping and a
// bare blend would just sound like the set running out of steam.
const MASKING: readonly TransitionStyle[] = ["washOut", "filter", "echoOut"];

/** What the set is doing right now, as far as the gesture is concerned. */
export interface StyleShape {
  arc: EnergyArc;
  /** Incoming energy minus outgoing, when BOTH are analysed; null when either is unknown.
   *  Null means "no opinion" and must never be read as zero — an unanalysed pair is not a flat
   *  one, and treating it as flat would apply the wind-down bias to half the library. */
  lift: number | null;
}

// How many positions to move a style, for this shape. Kept SMALL on purpose: the cap is the same
// promise `tolerance` makes — a clearly-better option is never sacrificed to be interesting. A
// gesture two places down the list is a peer; one eight places down is there because it does not
// belong, and no amount of arc should promote it.
const LIFT_STRONG = 0.18; // energy delta that counts as a real step up or down, not noise

// ★ A REAL STEP OVERRIDES THE STATED ARC — it does not argue with it.
//
// The first cut of this stacked an arc bias and a lift bias additively, and the arithmetic made
// the lift unable to ever matter: `blend` sits at index 0 in the mid-fit row AND collects the
// ride bonus, so no bounded nudge from the other direction could reach it. Stacking small deltas
// from two sources that disagree just means the one with the head start always wins, quietly.
//
// The rule that actually expresses the intent: the arc is what the user ASKED the set to do; the
// lift is what these two records ARE doing. When the records genuinely step — and in a "ride"
// they mostly don't, because the selector is aiming at the current energy, so a big lift here
// means it could not find a close match — the pair is the better evidence. A long blend across a
// real jump sounds like the new track bursting in halfway through, whatever the arc said.
function shapeDelta(style: TransitionStyle, shape: StyleShape): number {
  const step = shape.lift == null ? 0 : shape.lift >= LIFT_STRONG ? 1 : shape.lift <= -LIFT_STRONG ? -1 : 0;

  // A real step DOWN: nothing else applies. Hide the seam, or the set sounds like it is dying.
  if (step < 0) return MASKING.includes(style) ? -1.5 : 0;
  // A real step UP reads as a build regardless of what the arc was set to.
  const arc = step > 0 ? "build" : shape.arc;

  if (arc === "build") {
    // Climbing: reward arrival, penalise dissolve.
    if (FORWARD.includes(style)) return -1.5;
    if (style === "blend") return 1.5;
    return 0;
  }
  if (arc === "ride") {
    // Holding a groove: the transition should be the thing nobody notices.
    if (LONG.includes(style)) return -1;
    if (style === "cut" || style === "dropSwap") return 1;
    return 0;
  }
  // "journey" gets NO per-style bias — its variety comes from the wider tolerance, which is the
  // honest way to express "surprise me" (biasing toward a family would just pick a new rut).
  return 0;
}

export interface ResolveOpts {
  /** How far down the preference list an alternative may sit and still count as "equally good"
   *  when dodging a repeat. */
  tolerance?: number;
  /** The set's shape. Omitted → pair-only behaviour, exactly as before. */
  shape?: StyleShape;
}

/** Pick the style this transition will actually use.
 *
 *  Preference order (now shaped by the arc), then availability, then anti-repetition: among the
 *  styles that are BOTH suitable and possible, skip the one used last time if there is another
 *  equally-suitable candidate. "Equally suitable" means within `tolerance` positions — so a
 *  clearly-better option is never sacrificed just to be different. */
export function resolveStyle(
  plan: TransitionPlan,
  caps: StyleCapabilities,
  lastStyle: TransitionStyle | null,
  opts: ResolveOpts = {},
): TransitionStyle {
  const { shape } = opts;
  // "journey" means keep it moving, so it gets a wider net to dodge a repeat into.
  const tolerance = opts.tolerance ?? (shape?.arc === "journey" ? 2 : 1);
  const available = stylePreference(plan.score, plan.confident).filter((s) => styleAvailable(s, caps));
  if (!available.length) return "cut"; // always possible, and an honest answer for a hopeless pair
  // Stable re-rank: equal adjusted ranks keep preference order, so with no shape this is identity.
  const prefs = shape
    ? available
        .map((s, i) => ({ s, k: i + shapeDelta(s, shape), i }))
        .sort((a, b) => a.k - b.k || a.i - b.i)
        .map((x) => x.s)
    : available;
  const first = prefs[0];
  if (first !== lastStyle) return first;
  // The best option is what we just did — take the next one, but only if it is close behind.
  const alt = prefs.find((s, i) => s !== lastStyle && i <= tolerance);
  return alt ?? first;
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
