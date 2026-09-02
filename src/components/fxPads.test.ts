import { describe, expect, it } from "vitest";
import { chainRef, fxPadArg } from "./fxPads";
import type { Deck } from "@htl/audio";

// A chain id is a per-deck sequence number. It does not survive a reload, and it certainly does
// not survive the trip to another machine — so an fxPad gesture that named its chain by id always
// missed on the far side and fired whatever that deck happened to be aimed at. The wire carries
// the NAME, the same key applyFxChainSnapshot rebuilds on. These are the only two rules.
const deckWith = (focus: string, chains: { id: string; name: string; master?: boolean }[]) =>
  ({
    fxFocus: focus,
    fxChainList: chains,
    fxChain: (id: string) => chains.find((c) => c.id === id),
  }) as unknown as Deck;

const CHAINS = [
  { id: "c1", name: "Drums" },
  { id: "c2", name: "Vocal: dry" }, // a name with a colon — the slot parses off the LAST one
  { id: "master", name: "Master", master: true },
];

describe("fxPadArg — what goes on the wire", () => {
  it("names the focused chain, not its id", () => {
    expect(fxPadArg(deckWith("c1", CHAINS), 3)).toBe("Drums:3");
  });

  it("says master for the master chain", () => {
    expect(fxPadArg(deckWith("master", CHAINS), 0)).toBe("master:0");
  });

  it("says master when the focus points at a chain that is gone", () => {
    expect(fxPadArg(deckWith("c9", CHAINS), 1)).toBe("master:1");
  });

  it("keeps a colon in the name — the receiver splits on the last one", () => {
    const arg = fxPadArg(deckWith("c2", CHAINS), 7);
    expect(arg).toBe("Vocal: dry:7");
    expect(arg.slice(0, arg.lastIndexOf(":"))).toBe("Vocal: dry");
  });
});

describe("chainRef — what the receiver resolves it to", () => {
  it("matches a synced chain by name across differing ids", () => {
    // the far side rebuilt the same chains in a different order → different ids
    const far = deckWith("master", [
      { id: "c1", name: "Vocal: dry" },
      { id: "c2", name: "Drums" },
      { id: "master", name: "Master", master: true },
    ]);
    expect(chainRef(far, "Drums")?.id).toBe("c2");
  });

  it("still honours a live id — our own echo, and older recordings", () => {
    expect(chainRef(deckWith("master", CHAINS), "c1")?.name).toBe("Drums");
  });

  it("resolves master", () => {
    expect(chainRef(deckWith("master", CHAINS), "master")?.master).toBe(true);
  });

  it("returns nothing for a chain this deck does not have — the caller keeps its own focus", () => {
    expect(chainRef(deckWith("master", CHAINS), "Guitar")).toBeUndefined();
  });
});
