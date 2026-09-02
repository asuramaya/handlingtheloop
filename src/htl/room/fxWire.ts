// BUILDING THE FX INTENTS — one place, so the sender and the receiver cannot drift.
//
// Every FX emit site in the app (eleven panels, the strip, the MIDI router) used to hand-build
// `{ kind: "fxParam", deck, slot, param, value }`. That was fine while a slot WAS an address. It
// stopped being one when stem chains arrived and `slot` became an index into
// `chains.flatMap(devices)` — a list whose contents differ between two devices the moment their
// chains do. Eleven call sites is eleven chances to forget the new field, so none of them builds
// the message any more: they call these.
//
// The harness (roomSim.ts) builds its gestures with the SAME functions, which is what makes a
// green coordination test mean something about the app rather than about the test.

import type { DeckId, FxChainSlot, FxSlot, Intent } from "./protocol";

/** What these need from a deck. The real Deck and the simulator's FakeDeck both have it. */
export interface FxWireDeck {
  fxWireAddrAt(slot: number): { chain: string; fx: string } | undefined;
}
export interface FxRackDeck {
  fxSnapshot(): FxSlot[];
  fxChainsForWire(): FxChainSlot[];
}

/** A knob moved. Carries the slot (for older peers) AND the portable address (chain name + kind). */
export function fxParamIntent(deck: FxWireDeck, id: DeckId, slot: number, param: string, value: number): Intent {
  return { kind: "fxParam", deck: id, slot, param, value, ...deck.fxWireAddrAt(slot) };
}

/** A device bypassed. Same addressing rule. */
export function fxBypassIntent(deck: FxWireDeck, id: DeckId, slot: number, value: boolean): Intent {
  return { kind: "fxBypass", deck: id, slot, value, ...deck.fxWireAddrAt(slot) };
}

/** The whole rack: the master chain as always, PLUS the stem chains, which had no wire form —
 *  so adding a chain, renaming one, changing its stems or recalling a chain preset used to
 *  broadcast a message describing only the master while the far side kept whatever it had. */
export function fxRackIntent(deck: FxRackDeck, id: DeckId): Intent {
  return { kind: "fxRack", deck: id, rack: deck.fxSnapshot(), chains: deck.fxChainsForWire() };
}
