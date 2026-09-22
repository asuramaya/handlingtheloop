import { describe, test, expect } from "vitest";
import { deckNamePatch, type DeckNaming } from "./deckNameBackfill";
import type { DeckSnapshot } from "@htl";

const VID = "QJbPvDz0NTo";
const snap = (over: Partial<DeckSnapshot> = {}): DeckSnapshot =>
  ({ videoId: VID, name: "Strobe", artist: "deadmau5", bpm: 128, duration: 634, ...over }) as DeckSnapshot;
const deck = (over: Partial<DeckNaming> = {}): DeckNaming => ({ videoId: VID, name: "", artist: "", bpm: null, duration: 0, ...over });

describe("deckNamePatch", () => {
  test("names a deck that arrived nameless — the tick-resync load (thread 47468bb9)", () => {
    expect(deckNamePatch(deck(), snap())).toEqual({ name: "Strobe", artist: "deadmau5", bpm: 128, duration: 634 });
  });

  test("never renames a deck that already has a name", () => {
    expect(deckNamePatch(deck({ name: "Strobe", artist: "deadmau5", bpm: 128, duration: 634 }), snap({ name: "Something Else" }))).toBeNull();
  });

  test("fills only the blanks — a real BPM from the decode outranks the snapshot's", () => {
    expect(deckNamePatch(deck({ name: "Strobe", bpm: 127.9 }), snap())).toEqual({ artist: "deadmau5", duration: 634 });
  });

  test("never names the WRONG track: a snapshot for another videoId is ignored", () => {
    expect(deckNamePatch(deck(), snap({ videoId: "Pw71twKXpUk" }))).toBeNull();
    expect(deckNamePatch(deck({ videoId: null }), snap())).toBeNull();
  });

  test("an empty snapshot deck names nothing — a blank board must not blank a loaded deck", () => {
    expect(deckNamePatch(deck(), snap({ videoId: null }))).toBeNull();
    expect(deckNamePatch(deck(), snap({ name: "", artist: "", bpm: null, duration: 0 }))).toBeNull();
  });

  test("whitespace is not a name", () => {
    expect(deckNamePatch(deck({ name: "  " }), snap())?.name).toBe("Strobe");
    expect(deckNamePatch(deck(), snap({ name: "   " }))?.name).toBeUndefined();
  });
});
