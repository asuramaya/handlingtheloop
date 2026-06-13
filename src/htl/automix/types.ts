// Shared auto-mix types.

import type { TrackMeta } from "../library/types";

/** How a transition between two tracks is performed. `stemswap` is only chosen at
 *  runtime when both decks actually have stems loaded by mix time (see autoMixer);
 *  the queue plans `blend`/`cut` from compatibility and the mixer may upgrade. */
export type TransitionStyle = "blend" | "cut" | "stemswap";

export interface TransitionPlan {
  style: TransitionStyle;
  bars: number; // length of the transition, in bars of the outgoing track
  bassSwapBar: number; // bar within the transition where the low end swaps decks
  keyMatch: boolean; // engage harmonic key-match on the incoming deck
  score: number; // 0..1 mixability that produced this plan (for the UI badge)
}

/** Where the queue draws its next tracks from. */
export type MixMode = "playlist" | "radio";

/** AutoMixer state machine phases (Phase 3). */
export type AutoMixPhase = "idle" | "armed" | "preload" | "cueing" | "mixing" | "settle";

/** A read-only view of the queue for rendering. */
export interface QueueView {
  mode: MixMode;
  current: TrackMeta | null;
  upcoming: TrackMeta[];
  smartSort: boolean;
}
