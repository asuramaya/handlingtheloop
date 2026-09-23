import type { DeckId } from "./protocol";

// THE CLIENT'S HALF OF ONE PERMISSION RULE, as a pure function — because the other half lives on
// the server and the two must not be able to disagree.
//
// ★ THE SAME DECISION IS MADE TWICE, ON OPPOSITE SIDES OF A WIRE. The server decides with
// `canDriveIntent(decks, intent)` over a `decks` string ("" | "A" | "B" | "AB") and DROPS an
// out-of-lane intent — room.ts:797, whose own comment says the sender "already applied it locally".
// The client decides with `canDriveDeck(seat, id)` over `{ enabled, controlling, myDeck }`. If the
// two ever disagree the user gets the failure this entire guard programme exists to prevent: a
// control that moves THIS device and not the room, silently, with nothing reporting it (71277a23).
//
// ★ AND THE CONVERSION IS WHERE A DISAGREEMENT WOULD LIVE, which is why it is here rather than
// inline in a hook where no test can reach it. `myDeck: null` is a COLLAPSE — it means "holds both
// decks" and "holds no particular deck" and "is not on stage" all at once. That collapse is only
// safe because of a coupling on the OTHER side of the wire: the one server site that grants a
// single deck (room.ts:1348) sets `stage: true` in the same literal. Nothing states that, and
// nothing enforced it before seatOf.test.ts.
//
// If a future path ever writes `decks: "B"` without `stage: true`, this function returns
// `myDeck: null`, canDriveDeck says yes to BOTH decks, the user drives deck A, and the server
// silently drops it. The test scans for exactly that.

export interface Attachment {
  /** Which decks the SERVER says this device may drive: "" | "A" | "B" | "AB".
   *
   *  ★ THE ONLY GRANT FIELD. `controlling` used to sit beside this one, and their agreement —
   *  `controlling === (decks !== "")` — was a convention no artifact owned. The server wrote both in
   *  one literal at six sites; a test filter assumed the biconditional; a scan over room.ts was meant
   *  to establish it and could only compare string literals, so every live write (all ternaries and
   *  variables) passed it unexamined, including a measured INVERTED pairing. The two cannot disagree
   *  now, because there is only one of them. */
  decks: string;
  /** Stepped up from the floor onto a deck. */
  stage: boolean;
}

export interface Seat {
  enabled: boolean;
  controlling: boolean;
  myDeck: DeckId | null;
}

/** The seat this device holds, from the roster entry the server sent for it.
 *  `me` absent = a public-lobby listener who is not in the roster at all: no control, ever. */
export function seatOf(me: Attachment | null | undefined, opts: { enabled: boolean; floorListener: boolean }): Seat {
  if (opts.floorListener || !me) return { enabled: opts.enabled, controlling: false, myDeck: null };
  const onStage = me.stage;
  const myDeck: DeckId | null = onStage ? (me.decks === "A" ? "A" : me.decks === "B" ? "B" : null) : null;
  return { enabled: opts.enabled, controlling: me.decks !== "", myDeck };
}
