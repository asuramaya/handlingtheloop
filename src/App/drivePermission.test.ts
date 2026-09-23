import { describe, expect, it } from "vitest";
import { canDriveDeck, canDriveBoard, canSetLocalFeel, type SeatState } from "./drivePermission";

// The seat model, pinned. This logic governed every control surface in the app from three inline
// arrows inside a 4,000-line component, consulted through a ref — correct, and unreachable by any
// test. These cases are the ones a reader would otherwise have to derive from the comment.

const solo: SeatState = { enabled: false, controlling: false, myDeck: null };
const host: SeatState = { enabled: true, controlling: true, myDeck: null };
const stage: SeatState = { enabled: true, controlling: true, myDeck: "A" }; // stepped-up listener
const follower: SeatState = { enabled: true, controlling: false, myDeck: null };

describe("per-deck drive permission", () => {
  it("SOLO drives everything — the seat rules only bind inside a room", () => {
    // Without this bypass every local surface (keyboard, MIDI, gamepad) goes dead off-session,
    // because `controlling` is false when there is no rig to be controlling.
    expect(canDriveDeck(solo, "A")).toBe(true);
    expect(canDriveDeck(solo, "B")).toBe(true);
    expect(canDriveBoard(solo)).toBe(true);
  });

  it("a full controller drives both decks and the board", () => {
    expect(canDriveDeck(host, "A")).toBe(true);
    expect(canDriveDeck(host, "B")).toBe(true);
    expect(canDriveBoard(host)).toBe(true);
  });

  it("a stepped-up listener drives ONLY their own deck — and never the board", () => {
    expect(canDriveDeck(stage, "A")).toBe(true);
    expect(canDriveDeck(stage, "B")).toBe(false);
    expect(canDriveBoard(stage)).toBe(false); // the crossfader is a whole-board move
  });

  it("a pure follower drives neither deck", () => {
    expect(canDriveDeck(follower, "A")).toBe(false);
    expect(canDriveDeck(follower, "B")).toBe(false);
    expect(canDriveBoard(follower)).toBe(false);
  });

  it("REPLAY locks both decks and the board, whoever you are", () => {
    // Replay is driving them. A host who could still grab a deck mid-replay would be fighting it.
    for (const seat of [solo, host, stage, follower]) {
      expect(canDriveDeck(seat, "A", true)).toBe(false);
      expect(canDriveDeck(seat, "B", true)).toBe(false);
      expect(canDriveBoard(seat, true)).toBe(false);
    }
  });
});

describe("local feel is NOT drive permission", () => {
  // ★ THESE TWO PIN A POLICY, NOT AN INVARIANT. canSetLocalFeel takes no arguments, so it cannot
  // express "this device". If local feel ever becomes conditional — a phone listener with no jog
  // wheel — the signature changes and these change with it. A red test here is the policy moving,
  // not a regression, and that distinction is the reason it is written down. (Metron's boundary.)
  it("every seat may set its own jog physics, vinyl speed and slip", () => {
    // The distinction Metron added to the accessor ruling. These are properties of the hardware in
    // front of this person, not of the session: a listener whose jog wheel feels wrong has been
    // given a broken device, not a safe one. If this ever becomes canDriveDeck with a flag, the
    // difference stops being visible at the call site and the collapse is the bug.
    expect(canSetLocalFeel()).toBe(true);
  });

  it("it does not track drive permission — a follower still owns its own feel", () => {
    expect(canDriveDeck(follower, "A")).toBe(false);
    expect(canSetLocalFeel()).toBe(true);
  });
});

describe("the extraction is behaviour-preserving, proved over the whole state space", () => {
  // I ARGUED THIS WAS EQUIVALENT AND THEN CHECKED, because the refactor did not just move the
  // expressions — it re-expressed them. `deckLocked` was `(enabled && !canDrive(id)) || replay`
  // and is now `!canDrive(id, replay)`; `boardLocked` was `(enabled && !(controlling && myDeck ===
  // null)) || replay` and is now `!canDriveBoard(replay)`. Both readings are defensible and one of
  // them could have been wrong for exactly one seat, which is the kind of gap a green suite does
  // not close. The state space is 24 combinations, so there is no excuse for reasoning about it.
  const decks = ["A", "B"] as const;
  const seats: SeatState[] = [];
  for (const enabled of [false, true])
    for (const controlling of [false, true])
      for (const myDeck of [null, "A", "B"] as const) seats.push({ enabled, controlling, myDeck });

  it("deckLocked matches the original expression for every seat, deck and replay state", () => {
    for (const seat of seats)
      for (const id of decks)
        for (const replay of [false, true]) {
          const originalCanDrive = !seat.enabled || (seat.controlling && (seat.myDeck === null || seat.myDeck === id));
          const original = (seat.enabled && !originalCanDrive) || replay;
          expect({ seat, id, replay, locked: !canDriveDeck(seat, id, replay) }).toEqual({ seat, id, replay, locked: original });
        }
  });

  it("boardLocked matches the original expression for every seat and replay state", () => {
    for (const seat of seats)
      for (const replay of [false, true]) {
        const original = (seat.enabled && !(seat.controlling && seat.myDeck === null)) || replay;
        expect({ seat, replay, locked: !canDriveBoard(seat, replay) }).toEqual({ seat, replay, locked: original });
      }
  });

  it("and the ref-facing predicate is unchanged — the key handlers still ignore replay", () => {
    // canDriveDeckRef is consulted by three key handlers that never considered replay, and this
    // refactor deliberately did not change that. Pinning it so the inconsistency is a recorded
    // decision rather than an accident someone "fixes" without knowing it was load-bearing.
    for (const seat of seats)
      for (const id of decks) {
        const originalCanDrive = !seat.enabled || (seat.controlling && (seat.myDeck === null || seat.myDeck === id));
        expect(canDriveDeck(seat, id)).toBe(originalCanDrive);
      }
  });
});
