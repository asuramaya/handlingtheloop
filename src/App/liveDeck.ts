// WHICH DECK IS "NOW PLAYING" FOR THE SUGGESTIONS, when AUTO is not deciding it.
//
// Operator, 2026-11-04: the suggestions engine should "work all the time as i play songs ...
// whether or not auto is on, its kind of a superpower when performing". Off-AUTO the queue only
// re-centred when a track was LOADED, reading whichever deck happened to be playing at that
// instant — so starting the other deck, or fading across to it, never moved the suggestions.
// This is the rule a listener would use: the deck you can hear. One playing → that one. Both
// playing → the one the crossfader favours; dead centre keeps whichever was live (a blend in
// progress has not changed songs yet). Nothing playing → keep the last (a pause is not a change).
import type { DeckId } from "@htl/audio";

/** Crossfader distance from centre (of −1…+1) before it counts as favouring a side. */
const SIDE = 0.15;

export function pickLiveDeck(o: { aPlay: boolean; bPlay: boolean; crossfade: number; prev: DeckId | null; aLoaded: boolean; bLoaded: boolean }): DeckId | null {
  if (o.aPlay && !o.bPlay) return "A";
  if (o.bPlay && !o.aPlay) return "B";
  if (o.aPlay && o.bPlay) {
    if (o.crossfade <= -SIDE) return "A";
    if (o.crossfade >= SIDE) return "B";
    return o.prev ?? "A";
  }
  // Nothing playing: hold the last live deck while it still has a track; else whatever is loaded.
  if (o.prev === "A" && o.aLoaded) return "A";
  if (o.prev === "B" && o.bLoaded) return "B";
  return o.aLoaded ? "A" : o.bLoaded ? "B" : null;
}
