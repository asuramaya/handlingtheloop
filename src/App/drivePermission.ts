import type { DeckId } from "../htl/room/protocol";

// WHO MAY DRIVE WHAT, extracted from App.tsx as pure logic so it can be TESTED rather than read.
//
// It was three inline arrows in a 4,000-line component, consulted through a ref from three key
// handlers and by the whole control surface. That is the same shape as every guard this session
// has had to chase: correct, unreachable by a test, and re-stated wherever it is needed.
//
// The seat model (E3/E4): SOLO always drives — the seat rules only bind once you are IN a room. A
// full controller/host (myDeck null) drives both decks; a stepped-up listener drives ONLY their own
// deck; a pure follower drives neither. Without the !enabled bypass every local control surface —
// keyboard, MIDI, gamepad — goes dead off-session, because `controlling` is false with no rig.
//
// ★ AND THE DISTINCTION METRON ADDED TO THE ACCESSOR RULING (199f51bc), encoded here rather than
// left to a comment: LOCAL-FEEL access is not drive access. Jog physics, vinyl speed and slip are
// this DEVICE's preferences about how its own surface behaves; gating them would make a listener's
// own hardware feel broken. The two must never collapse into one predicate with a flag — if they
// do, we are back where we started, and the difference has to be visible at the call site.

export interface SeatState {
  /** In a room at all. False = solo rig, which drives everything. */
  enabled: boolean;
  /** Granted control (a host's own devices, or a guest the host approved). */
  controlling: boolean;
  /** The single deck this seat was given, or null for a full controller/host. */
  myDeck: DeckId | null;
}

/** May this device DRIVE that deck — jog, seek, bend, the button bank? */
export function canDriveDeck(seat: SeatState, id: DeckId, replayActive = false): boolean {
  if (replayActive) return false; // replay is driving them; nobody else may
  return !seat.enabled || (seat.controlling && (seat.myDeck === null || seat.myDeck === id));
}

/** A whole-board move (the crossfader) needs FULL control — never a stage DJ, never a follower. */
export function canDriveBoard(seat: SeatState, replayActive = false): boolean {
  if (replayActive) return false;
  return !seat.enabled || (seat.controlling && seat.myDeck === null);
}

/** May this device change how its OWN surface feels — jog physics, vinyl speed, slip?
 *
 *  Always. It is a property of the hardware in front of this person, not of the session, and a
 *  listener whose jog wheel feels wrong has been given a broken device rather than a safe one.
 *  A function rather than a constant so the call site READS as a different question from
 *  canDriveDeck, which is the whole point of separating them. */
export function canSetLocalFeel(): boolean {
  return true;
}
