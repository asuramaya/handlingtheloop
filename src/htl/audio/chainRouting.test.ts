import { describe, expect, it } from "vitest";
import { anyChainWaitingForStems, chainIsDeaf, chainWaitingForStems } from "./chainRouting";

const VOICE = 4; // 1=DRUM 2=BASS 4=VOICE 8=INST
const ch = (stems: number, master = false) => ({ stems, master });

describe("chainWaitingForStems", () => {
  it("is TRUE for the exact case the operator hit: a chain on vocals with nothing separated", () => {
    expect(chainWaitingForStems(ch(VOICE), false)).toBe(true);
  });

  it("is FALSE once stems exist — the chain starts working, nothing to explain", () => {
    expect(chainWaitingForStems(ch(VOICE), true)).toBe(false);
  });

  it("is FALSE for a chain claiming NO stems — that is DEAF, a different fault with a different fix", () => {
    // Conflating them would tell someone to separate a track when what they need is to pick a stem.
    expect(chainWaitingForStems(ch(0), false)).toBe(false);
    expect(chainIsDeaf(ch(0))).toBe(true);
  });

  it("is FALSE for the master in every combination — it takes the SUM, after the chains", () => {
    for (const stems of [0, VOICE, 15]) {
      for (const has of [true, false]) {
        expect(chainWaitingForStems(ch(stems, true), has)).toBe(false);
        expect(chainIsDeaf(ch(stems, true))).toBe(false);
      }
    }
  });

  it("waiting and deaf are mutually exclusive — a chain is never both", () => {
    for (const stems of [0, 1, VOICE, 15]) {
      for (const has of [true, false]) {
        const c = ch(stems);
        expect(chainWaitingForStems(c, has) && chainIsDeaf(c)).toBe(false);
      }
    }
  });
});

describe("anyChainWaitingForStems", () => {
  it("spots one waiting chain beside a deaf one and the master", () => {
    expect(anyChainWaitingForStems([ch(0, true), ch(0), ch(VOICE)], false)).toBe(true);
  });

  it("is false with no stem-claiming chains at all — the common case, and it must stay quiet", () => {
    expect(anyChainWaitingForStems([ch(0, true), ch(0)], false)).toBe(false);
  });

  it("is false once stems land, without the chains changing", () => {
    const chains = [ch(0, true), ch(VOICE), ch(1)];
    expect(anyChainWaitingForStems(chains, false)).toBe(true);
    expect(anyChainWaitingForStems(chains, true)).toBe(false);
  });
});
