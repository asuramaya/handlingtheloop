import { describe, it, expect, vi } from "vitest";
import type { Deck } from "@htl/audio";
import { registerBoardAction, applyBoardAction } from "./boardActions";

// The board gesture bus is the dumb pipe that the room protocol, the recorded-set recipe, and
// replay ALL flow a {deck, id, phase, arg} intent through — so its dispatch contract (known id
// → call the registered fn with the exact args; unknown id → no-op, never throw) is what keeps
// the transport stable across board iterations. A fake deck is enough: only the registered fn
// touches it. Ids are unique per test since the registry is module-global with no unregister.
const fakeDeck = () => ({ setPadMode: vi.fn() }) as unknown as Deck;

describe("applyBoardAction", () => {
  it("dispatches a registered id with the exact (deck, phase, arg)", () => {
    const apply = vi.fn();
    registerBoardAction("test:dispatch", apply);
    const deck = fakeDeck();
    const ok = applyBoardAction(deck, "test:dispatch", "down", "slot3");
    expect(ok).toBe(true);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith(deck, "down", "slot3");
  });

  it("forwards undefined phase/arg verbatim (momentary vs payload-less gestures)", () => {
    const apply = vi.fn();
    registerBoardAction("test:bare", apply);
    const deck = fakeDeck();
    applyBoardAction(deck, "test:bare");
    expect(apply).toHaveBeenCalledWith(deck, undefined, undefined);
  });

  it("forward-compat: an UNKNOWN id no-ops (returns false, never throws)", () => {
    const deck = fakeDeck();
    expect(() => applyBoardAction(deck, "test:never-registered", "down", 1)).not.toThrow();
    expect(applyBoardAction(deck, "test:never-registered")).toBe(false);
  });

  it("re-registering an id REPLACES the handler (last writer wins)", () => {
    const first = vi.fn();
    const second = vi.fn();
    registerBoardAction("test:replace", first);
    registerBoardAction("test:replace", second);
    applyBoardAction(fakeDeck(), "test:replace");
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("a numeric arg (pad slot) is passed through as a number", () => {
    const apply = vi.fn();
    registerBoardAction("test:num", apply);
    applyBoardAction(fakeDeck(), "test:num", "up", 7);
    expect(apply).toHaveBeenCalledWith(expect.anything(), "up", 7);
  });
});

// The one built-in registered at module load: padMode → deck.setPadMode(arg), but only for a
// string arg (a stray numeric/undefined payload must not drive the pad bank).
describe("built-in padMode action", () => {
  it("sets the pad mode from a string arg", () => {
    const deck = fakeDeck();
    const ok = applyBoardAction(deck, "padMode", undefined, "loop");
    expect(ok).toBe(true);
    expect(deck.setPadMode).toHaveBeenCalledWith("loop");
  });

  it("ignores a non-string arg", () => {
    const deck = fakeDeck();
    applyBoardAction(deck, "padMode", undefined, 3);
    expect(deck.setPadMode).not.toHaveBeenCalled();
  });
});
