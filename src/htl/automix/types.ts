// Shared auto-mix types.

import type { TrackMeta } from "../library/types";

/** How a transition between two tracks is performed.
 *
 *  ★ WHY THERE ARE MORE THAN FOUR OF THESE NOW. The bars and the style varied with the pair's
 *  compatibility, but the GESTURE never did: every mix was a linear crossfade with a bass swap at
 *  `bassSwapBar`. Parameterised, but singular — so after three transitions you had seen everything
 *  AUTO could do, and the fourth one told you a machine was driving. A DJ's vocabulary is what
 *  makes a set feel performed, and most of it was already sitting unused on the Deck API.
 *
 *  ★ ONLY ONE OF THESE NEEDS STEMS. Separation is optional and often late, so the gestures that
 *  carry the character — the echo, the reverb wash, the gate chop, the loop chop — are built from
 *  the channel FX and the loop engine, both of which every deck always has. A track that never gets
 *  separated still gets an interesting transition; the stem swap is a bonus, not the point.
 *
 *  Availability is a RUNTIME question, not a planning one: `stemswap` needs both decks separated,
 *  `dropSwap` needs a detected body section on the incoming, and anything rhythmic needs a grid. The planner proposes from compatibility; `resolveStyle` picks what is actually
 *  possible at mix time and refuses to repeat itself when it has a choice. */
export type TransitionStyle =
  | "blend"
  | "cut"
  | "stemswap"
  | "filter"
  | "echoOut"
  | "washOut"
  | "gateChop"
  | "loopChop"
  | "dropSwap"
  | "spinOut";

export interface TransitionPlan {
  style: TransitionStyle;
  bars: number; // length of the transition, in bars of the outgoing track
  bassSwapBar: number; // bar within the transition where the low end swaps decks
  keyMatch: boolean; // engage harmonic key-match on the incoming deck
  score: number; // 0..1 mixability that produced this plan (for the UI badge)
  keyKnown: boolean; // the key relationship was actually known (not a neutral guess)
  confident: boolean; // at least one of key/tempo was known for both tracks
  /** Hold the outgoing track in a 4-bar loop at its exit point until the incoming's body arrives.
   *  Orthogonal to `style` — it buys RUNWAY, it is not itself a way of blending. Set when the
   *  incoming needs more intro time under the outgoing than the outgoing has left to give. */
  loopExtend?: boolean;
}

/** What the decks can actually do at mix time. The planner works from metadata; these are facts
 *  only the engine knows, checked the moment the transition starts. */
export interface StyleCapabilities {
  stems: boolean; // BOTH decks separated
  /** The channel FX rack is reachable. Effectively always true — every deck carries the whole
   *  pad-FX bank permanently and dormant (Deck.PERMANENT_KINDS) — but it stays a capability so a
   *  deck in an unexpected state degrades to a plain blend instead of throwing mid-transition. */
  fx: boolean;
  incomingBody: boolean; // the incoming has a detected body section to cut to
  grid: boolean; // both decks have a beatgrid (needed for anything rhythmic)
}

/** Where the queue draws its next tracks from. */
export type MixMode = "playlist" | "radio";

/** The shape of a set's energy over time — what turns a sequence of compatible tracks into
 *  something that goes somewhere. `ride` holds the level the user established, `build` climbs and
 *  releases, `journey` swells and ebbs over roughly ten tracks. */
export type EnergyArc = "ride" | "build" | "journey";

/** WHAT THE RADIO SHOULD SOUND LIKE RIGHT NOW — supplied by the AutoMixer to `queue.ensureNext`.
 *
 *  ★ This type exists because its absence was a live bug. The AutoMixer has always maintained a
 *  vibe `anchor` (the track the user last put on) and an exported, unit-TESTED `radioSeedSet()`
 *  that combined it with the live deck; every call site dutifully computed the seeds and passed
 *  them in. `ensureNext` named the parameter `_legacySeeds` and never read it — a half-finished
 *  refactor left the caller side intact and silently inert. So the anchor influenced nothing, and
 *  a set drifted freely after three songs. The context is now a real, typed argument that the
 *  queue actually consumes. */
export interface RadioContext {
  /** The vibe the user set — the track they last chose by hand. Decays; never reaches zero. */
  anchor: TrackMeta | null;
  /** What is playing right now. */
  current: TrackMeta | null;
  /** Tracks played since the anchor was set — drives its decay. */
  anchorAge: number;
  /** Tracks AUTO has played this session — drives the arc's position. */
  played: number;
  /** The energy shape to aim for. */
  arc: EnergyArc;
}

/** AutoMixer state machine phases. `manual` = the user grabbed the crossfader mid-mix
 *  and is finishing it by hand; the mixer stands back until one deck is left. */
export type AutoMixPhase = "idle" | "armed" | "preload" | "cueing" | "mixing" | "settle" | "manual";

/** A read-only view of the queue for rendering. */
export interface QueueView {
  mode: MixMode;
  current: TrackMeta | null;
  upcoming: TrackMeta[];
  smartSort: boolean;
}
