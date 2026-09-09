import { describe, expect, it } from "vitest";
import { MIC_CHAIN, micChainOf, seedMicChain } from "./micChain";
import type { Deck } from "./Deck";
import type { FxChain } from "./Fx";

// THE MIC CHAIN IS AN OFFER, NOT A FIXTURE.
//
// The whole contract is about what happens the SECOND and THIRD time — seeding once is the easy
// half and would pass under every wrong implementation here. What has to hold:
//   • re-routing the mic to a deck that already has the chain must not touch it (no second reverb,
//     no reset of what they dialled),
//   • deleting it must make it stay deleted, which is the ONLY way to decline,
//   • and each deck is offered separately, because the chain lives in a deck's rack.
//
// So every test below drives a SEQUENCE. Deck is faked to the three members seedMicChain actually
// uses — a real Deck needs an AudioContext, and none of this is about audio.

function fakeDeck(): Deck & { chains: FxChain[]; adds: string[] } {
  const chains: FxChain[] = [];
  const adds: string[] = [];
  let seq = 0;
  const d = {
    chains,
    adds,
    rack: { get chainList() { return chains; } },
    addFxChain(name: string, stems = 0): FxChain {
      const c: FxChain = { id: `c${seq++}`, name, stems, devices: [] };
      chains.push(c);
      adds.push(name);
      return c;
    },
    addFxTo(chainId: string, kind: string) {
      const c = chains.find((x) => x.id === chainId);
      if (!c) return null;
      (c.devices as unknown[]).push({ kind });
      return { kind };
    },
  };
  return d as unknown as Deck & { chains: FxChain[]; adds: string[] };
}

describe("the MIC chain is offered once per device", () => {
  it("seeds on the first route, with a starting device and no stems claimed", () => {
    const deck = fakeDeck();
    const c = seedMicChain(deck, false);
    expect(c).not.toBeNull();
    expect(c!.name).toBe(MIC_CHAIN);
    // No stems ON PURPOSE: micIn feeds this chain's head directly. Claiming one would STEAL it
    // from the track, which is the opposite of what routing a mic here means.
    expect(c!.stems).toBe(0);
    expect(c!.devices).toHaveLength(1);
  });

  it("is idempotent — re-routing to the same deck returns the SAME chain, untouched", () => {
    const deck = fakeDeck();
    const first = seedMicChain(deck, false)!;
    (first.devices as unknown[]).push({ kind: "delay" }); // the user builds it out
    const again = seedMicChain(deck, true);
    const third = seedMicChain(deck, true);
    expect(again).toBe(first);
    expect(third).toBe(first);
    expect(first.devices).toHaveLength(2); // their delay survives; nothing re-seeded on top
    expect(deck.adds).toEqual([MIC_CHAIN]); // exactly one chain ever created
  });

  it("stays deleted — deleting the chain is how the offer is declined", () => {
    const deck = fakeDeck();
    const c = seedMicChain(deck, false)!;
    deck.chains.splice(deck.chains.indexOf(c), 1); // the user removes it
    expect(seedMicChain(deck, true)).toBeNull();
    expect(seedMicChain(deck, true)).toBeNull();
    expect(deck.chains).toHaveLength(0);
    expect(deck.adds).toEqual([MIC_CHAIN]);
  });

  it("offers each deck separately — the chain lives in ONE deck's rack", () => {
    const a = fakeDeck();
    const b = fakeDeck();
    seedMicChain(a, false);
    // `seeded` is device-wide, so B's first route arrives with the flag already true. B must still
    // get its chain, or pointing the mic at the other deck would silently do nothing.
    expect(micChainOf(b)).toBeNull();
    expect(seedMicChain(b, false)).not.toBeNull();
    expect(micChainOf(b)!.name).toBe(MIC_CHAIN);
  });

  it("adopts a MIC chain the user built by hand, rather than making a second one", () => {
    const deck = fakeDeck();
    const mine = deck.addFxChain(MIC_CHAIN, 0);
    const got = seedMicChain(deck, false);
    expect(got).toBe(mine);
    expect(got!.devices).toHaveLength(0); // not seeded over — it is theirs
    expect(deck.chains).toHaveLength(1);
  });

  // FxRack.setChainName does not refuse the master, so a master NAMED "MIC" is reachable — and it
  // can never be the mic's chain: rebuild() builds heads from `chains.filter(c => c !== master)`,
  // so micIn would still land on the sum while this code believed it had found a chain. The
  // `!c.master` guard is what stops that disagreement, and this is the test that holds it.
  it("refuses a MASTER that happens to be named MIC — it can never carry the mic", () => {
    const deck = fakeDeck();
    const master = deck.addFxChain(MIC_CHAIN, 0);
    (master as unknown as { master: boolean }).master = true;
    expect(micChainOf(deck)).toBeNull();
    const c = seedMicChain(deck, false)!;
    expect(c).not.toBe(master);
    expect(c.name).toBe(MIC_CHAIN);
    expect(deck.chains).toHaveLength(2);
  });

  it("never mistakes the master or a custom chain for the MIC one", () => {
    const deck = fakeDeck();
    deck.addFxChain("MIX", 0b1111);
    const master = deck.addFxChain("MASTER", 0);
    (master as unknown as { master: boolean }).master = true;
    expect(micChainOf(deck)).toBeNull();
    const c = seedMicChain(deck, false)!;
    expect(c.name).toBe(MIC_CHAIN);
    expect(micChainOf(deck)).toBe(c);
  });
});
