import type { FxChainSlot, FxSlot } from "../htl/room/protocol";

// Applying a snapshot's FX to a deck — BOTH halves.
//
// ★ THE MASTER RACK IS NOT THE WHOLE RACK. `fx` has only ever described the master chain;
// the STEM chains (a DJ's per-stem racks) ride in `fxChains`. deckSnapshot writes both
// (App.tsx), the local session restore applies both (App.tsx), and the live `fxRack` intent
// applies both (applyIntent.ts) — but the follower's snapshot reconcile applied only `fx`.
// Intents are NOT cached for a late joiner (server/room.ts CACHE_KIND marks `intent` "live"),
// so a listener who joined after the host built its stem chains received the state snapshot,
// which carries them, and then dropped that half on the floor — the chains stayed absent until
// the host happened to edit one.
//
// Undefined means "this snapshot doesn't describe it" and leaves the deck alone; that rule is
// applyFxChainSnapshot's own (an older peer's snapshot must never destroy live chains).
export interface DeckFxTarget {
  applyFxSnapshot(fx: FxSlot[]): void;
  applyFxChainSnapshot(chains: ReadonlyArray<FxChainSlot> | undefined): void;
}

export function applyDeckFxSnapshot(deck: DeckFxTarget, d: { fx?: FxSlot[]; fxChains?: FxChainSlot[] }): void {
  if (d.fx !== undefined) deck.applyFxSnapshot(d.fx);
  if (d.fxChains !== undefined) deck.applyFxChainSnapshot(d.fxChains);
}
