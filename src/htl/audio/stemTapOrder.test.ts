import { describe, expect, it } from "vitest";
import { CHAIN_STEM_ORDER, Deck } from "./Deck";
import { STEM_NAMES } from "../stems";

// ★ THE CHAIN'S STEM BUTTONS ROUTED THE WRONG STEMS (operator, 2026-11-08: "the stem buttons are
// mismatched on the chain"). A chain bit (D=1 B=2 V=4 I=8) was used as a position into the
// worklet's outputs, which follow STEM_NAMES (vocals, drums, bass, other): D played vocals, B
// drums, V bass. This pins each chain bit to the worklet output carrying THAT stem.
describe("Deck.stemTap: a chain stem bit taps its own stem", () => {
  it("bit i → the worklet output of CHAIN_STEM_ORDER[i]", () => {
    const fake = {
      stretchNode: { connect: (n: { out?: number }, out: number) => { n.out = out; } },
      stemTapsOn: true,
      stemTapNodes: null,
      ctx: { createGain: () => ({}) },
      setStemTaps() {},
    };
    expect(CHAIN_STEM_ORDER).toEqual(["drums", "bass", "vocals", "other"]);
    for (let i = 0; i < 4; i++) {
      const tap = (Deck.prototype.stemTap as (this: unknown, i: number) => { out?: number } | null).call(fake, i);
      // output 0 is the mix; output g+1 carries STEM_NAMES[g]
      expect(tap?.out).toBe(1 + STEM_NAMES.indexOf(CHAIN_STEM_ORDER[i]));
    }
  });
});
