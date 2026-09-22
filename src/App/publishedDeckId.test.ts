import { describe, test, expect } from "vitest";
import { publishedDeckId } from "./publishedDeckId";

const HELD = "QJbPvDz0NTo";
const INCOMING = "Pw71twKXpUk";

describe("publishedDeckId", () => {
  test("a loaded deck publishes what it holds", () => {
    expect(publishedDeckId(HELD, "")).toBe(HELD);
  });

  test("★ a deck still loading publishes the INCOMING track, not emptiness", () => {
    // The whole point: a returning host must not overwrite the room's good board with A=— B=—
    // while its own decks are mid-decode.
    expect(publishedDeckId(null, INCOMING)).toBe(INCOMING);
  });

  test("a genuinely empty deck publishes nothing", () => {
    expect(publishedDeckId(null, "")).toBeNull();
  });

  test("what it HOLDS outranks what it is loading — a deck swapping tracks still announces the old one until the new one lands", () => {
    expect(publishedDeckId(HELD, INCOMING)).toBe(HELD);
  });
});
