// What a deck SAYS it is holding when the board is published.
//
// ★ "NOT LOADED YET" IS NOT "EMPTY", AND PUBLISHING THE SECOND ERASES A ROOM'S GOOD BOARD.
// Reproduced deliberately on the rig: a host reloads, the room hands it back the board it had a
// moment ago (`catch-up served … A=QJbPvDz0NTo B=Pw71twKXpUk`), and then the host — whose decks are
// still decoding — publishes `A=— B=—` over it. A listener who tunes in during those seconds is
// served that emptiness and lands on nothing. The room had the right answer and the returning host
// destroyed it, then rebuilt it four seconds later, one deck at a time.
//
// The board already knows which tracks are coming: they are the loads in flight. Publishing the
// INCOMING id is both true and useful — a listener starts the same load instead of waiting out the
// window, and the name catches up through the snapshot (App/deckNameBackfill.ts).
//
// The distinction that matters: this uses the load that is RUNNING, not the deck's dedupe claim.
// The claim deliberately survives a successful land (it is the per-deck "already have this" key), so
// reading it here would keep announcing a track the user had since unloaded.

/** The videoId to publish for a deck: what it holds, or what it is loading, or nothing. */
export function publishedDeckId(loadedId: string | null, loadingNow: string): string | null {
  return loadedId ?? (loadingNow || null);
}
