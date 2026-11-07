import { describe, expect, test } from "vitest";
import { pickLiveDeck } from "./liveDeck";

const base = { aPlay: false, bPlay: false, crossfade: 0, prev: null, aLoaded: true, bLoaded: true } as const;

describe("pickLiveDeck — the deck you can hear", () => {
  test("one deck playing is the live one", () => {
    expect(pickLiveDeck({ ...base, aPlay: true })).toBe("A");
    expect(pickLiveDeck({ ...base, bPlay: true, prev: "A" })).toBe("B"); // starting B moves it
  });
  test("both playing: the crossfader decides, and the centre holds", () => {
    expect(pickLiveDeck({ ...base, aPlay: true, bPlay: true, crossfade: 0.6, prev: "A" })).toBe("B");
    expect(pickLiveDeck({ ...base, aPlay: true, bPlay: true, crossfade: -0.6, prev: "B" })).toBe("A");
    expect(pickLiveDeck({ ...base, aPlay: true, bPlay: true, crossfade: 0.05, prev: "A" })).toBe("A"); // mid-blend
  });
  test("a pause is not a change of song", () => {
    expect(pickLiveDeck({ ...base, prev: "B" })).toBe("B");
    expect(pickLiveDeck({ ...base, prev: "B", bLoaded: false })).toBe("A");
    expect(pickLiveDeck({ ...base, aLoaded: false, bLoaded: false })).toBeNull();
  });
});
