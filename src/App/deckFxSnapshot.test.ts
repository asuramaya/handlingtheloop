import { describe, test, expect, vi } from "vitest";
import { applyDeckFxSnapshot } from "./deckFxSnapshot";
import type { FxChainSlot, FxSlot } from "../htl/room/protocol";

const target = () => ({ applyFxSnapshot: vi.fn(), applyFxChainSnapshot: vi.fn() });
const fx: FxSlot[] = [{ kind: "reverb", bypassed: false, params: {} }];
const chains: FxChainSlot[] = [{ name: "vox", stems: 0b0100, devices: fx }];

describe("applyDeckFxSnapshot", () => {
  test("applies the master rack AND the stem chains", () => {
    const deck = target();
    applyDeckFxSnapshot(deck, { fx, fxChains: chains });
    expect(deck.applyFxSnapshot).toHaveBeenCalledWith(fx);
    expect(deck.applyFxChainSnapshot).toHaveBeenCalledWith(chains);
  });

  test("an empty chain list is applied — it means 'no stem chains', not 'no news'", () => {
    const deck = target();
    applyDeckFxSnapshot(deck, { fx, fxChains: [] });
    expect(deck.applyFxChainSnapshot).toHaveBeenCalledWith([]);
  });

  test("a snapshot that describes neither touches neither", () => {
    const deck = target();
    applyDeckFxSnapshot(deck, {});
    expect(deck.applyFxSnapshot).not.toHaveBeenCalled();
    expect(deck.applyFxChainSnapshot).not.toHaveBeenCalled();
  });
});
