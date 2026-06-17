import { describe, it, expect } from "vitest";
import { canDriveIntent, type Intent } from "./protocol";

// The per-deck drive gate (E3): a stepped-up listener may push exactly their one deck;
// the host/granted ("AB") drive everything; a deck-less move needs full control.
describe("canDriveIntent", () => {
  const deckA: Intent = { kind: "control", deck: "A", param: "tempo", value: 1 };
  const deckB: Intent = { kind: "control", deck: "B", param: "tempo", value: 1 };
  const stemB: Intent = { kind: "stemGain", deck: "B", stem: "vocals", value: 0.5 };
  const loadA: Intent = { kind: "load", deck: "A", videoId: "x" };
  const crossfade: Intent = { kind: "crossfade", value: 0.3 }; // deck-less (whole board)
  const tempoRange: Intent = { kind: "tempoRange", value: 8 }; // deck-less
  const automix: Intent = { kind: "automix", action: "skip" }; // deck-less
  const queue: Intent = { kind: "queue", action: "remove", videoId: "y" }; // deck-less

  it("denies everything with no permission", () => {
    expect(canDriveIntent("", deckA)).toBe(false);
    expect(canDriveIntent("", crossfade)).toBe(false);
  });

  it("a single-deck controller drives only that deck", () => {
    expect(canDriveIntent("B", deckB)).toBe(true);
    expect(canDriveIntent("B", stemB)).toBe(true);
    expect(canDriveIntent("B", deckA)).toBe(false);
    expect(canDriveIntent("B", loadA)).toBe(false);
    expect(canDriveIntent("A", deckA)).toBe(true);
    expect(canDriveIntent("A", deckB)).toBe(false);
  });

  it("a single-deck controller cannot make deck-less (whole-board) moves", () => {
    for (const i of [crossfade, tempoRange, automix, queue]) {
      expect(canDriveIntent("A", i)).toBe(false);
      expect(canDriveIntent("B", i)).toBe(false);
    }
  });

  it("full control drives every deck and every whole-board move", () => {
    for (const i of [deckA, deckB, stemB, loadA, crossfade, tempoRange, automix, queue]) {
      expect(canDriveIntent("AB", i)).toBe(true);
    }
  });
});
