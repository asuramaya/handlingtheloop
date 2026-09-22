import { describe, expect, it } from "vitest";
import { republishSnapshot } from "./republish";

describe("republishSnapshot", () => {
  it("prefers the board as it stands NOW over the last published one", () => {
    expect(republishSnapshot({ decks: "now" }, { decks: "old" })).toEqual({ decks: "now" });
  });
  it("falls back to the last published board when the app cannot answer", () => {
    expect(republishSnapshot(undefined, { decks: "old" })).toEqual({ decks: "old" });
  });
  it("★ THE CASE THAT WAS MISSED: a freshly loaded page has published nothing, and a provider is the only answer", () => {
    expect(republishSnapshot({ decks: "now" }, undefined)).toEqual({ decks: "now" });
  });
  it("stays silent when there is genuinely no board — inventing one would be served to every later joiner", () => {
    expect(republishSnapshot(undefined, undefined)).toBeUndefined();
  });
  it("control: a deliberately EMPTY board is an answer, not an absence — null and {} both survive", () => {
    expect(republishSnapshot(null, { decks: "old" })).toBeNull();
    expect(republishSnapshot({}, { decks: "old" })).toEqual({});
  });
});
