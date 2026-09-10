import { describe, expect, it } from "vitest";
import { chainRef, fxPadArg } from "./fxPads";
import type { Deck } from "@htl/audio";

// A chain id is a per-deck sequence number. It does not survive a reload, and it certainly does
// not survive the trip to another machine — so an fxPad gesture that named its chain by id always
// missed on the far side and fired whatever that deck happened to be aimed at. The wire carries
// the NAME, the same key applyFxChainSnapshot rebuilds on. These are the only two rules.
// ★ THE DOUBLE MODELS `padChain`, NOT JUST `fxFocus`, and it has to: the wire arg names the chain
// the press ACTUALLY hit, which in FX2 is the master chain and not the focused one. The `as unknown
// as Deck` cast below is why a drift here is invisible to tsc — a double that lies about its shape
// silences the compiler, so the rule it models has to be kept honest by hand. It mirrors Deck's own
// getter deliberately rather than hardcoding an answer.
const deckWith = (
  focus: string,
  chains: { id: string; name: string; master?: boolean }[],
  padMode: "fx" | "fx2" = "fx",
) =>
  ({
    fxFocus: focus,
    padMode,
    padChain: padMode === "fx2" ? "master" : focus,
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

// FX2 is the SECOND BANK: the same 8 pads aimed at the master chain instead of the focused one,
// mirroring rekordbox's PAD FX 1 / PAD FX 2 (two independent banks of assignments, identical
// momentary behaviour — Pioneer's Pad Editor defines both with the same sentence).
describe("fxPadArg — FX2 names the bank it actually fired", () => {
  it("sends master from FX2 even while another chain is focused", () => {
    // The bug this prevents: encoding the FOCUSED chain would make a co-DJ fire a different
    // effect from the one the sender just heard, which is precisely what the name-on-the-wire
    // format was rewritten to stop.
    expect(fxPadArg(deckWith("c1", CHAINS, "fx2"), 3)).toBe("master:3");
  });

  it("still sends the focused chain's NAME from FX", () => {
    expect(fxPadArg(deckWith("c1", CHAINS, "fx"), 3)).toBe("Drums:3");
  });

  it("the two banks disagree exactly when focus is not master — and agree when it is", () => {
    // Honest about the limit: with no chains made, focus IS master, so both banks show the same
    // devices. That is not a duplicate bank, it is one chain seen twice, and it resolves itself
    // the moment a stem chain exists.
    expect(fxPadArg(deckWith("c1", CHAINS, "fx"), 0)).not.toBe(fxPadArg(deckWith("c1", CHAINS, "fx2"), 0));
    expect(fxPadArg(deckWith("master", CHAINS, "fx"), 0)).toBe(fxPadArg(deckWith("master", CHAINS, "fx2"), 0));
  });
});
