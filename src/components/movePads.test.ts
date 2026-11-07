import { describe, expect, it } from "vitest";
import { MOVE_PADS } from "./movePads";
import { fireFxPadArg, fxPadPress, fxPadRelease, padsForDeck } from "./fxPads";
import type { Deck } from "@htl/audio";

// FX2 = deck moves (operator, 2026-11-07): SPIN · CENSOR · BRAKE · CUT / — · FREEZE · — · —.
// Every move but CUT runs on the deck's move stack (moveDown / moveUp — see moveStack.test.ts).
function fakeDeck(padMode = "fx2") {
  const held = new Set<string>();
  return {
    padMode,
    calls: [] as string[],
    cut: false,
    moveDown(k: string) { this.calls.push(`down ${k}`); held.add(k); },
    moveUp(k: string) { this.calls.push(`up ${k}`); held.delete(k); },
    moveHeld: (k: string) => held.has(k),
    spinback() { this.calls.push("spinback"); },
    setCut(on: boolean) { this.cut = on; },
    get cutting(): boolean { return this.cut; },
  };
}
const D = (d: ReturnType<typeof fakeDeck>) => d as unknown as Deck;

describe("FX2 moves", () => {
  it("the bank: SPIN · CENSOR · BRAKE · CUT / — · FREEZE · — · —", () => {
    expect(padsForDeck(D(fakeDeck())).map((p) => p?.label ?? null)).toEqual(["SPIN", "CENSOR", "BRAKE", "CUT", null, "FREEZE", null, null]);
  });

  it("a move pad is a held stack move: down on press, up on release", () => {
    const d = fakeDeck();
    const brake = MOVE_PADS[2]!;
    brake.on(D(d));
    expect(brake.active!(D(d))).toBe(true);
    brake.off!(D(d));
    expect(d.calls).toEqual(["down brake", "up brake"]);
  });

  it("CUT is not a stack move: it only mutes, so it layers over the others", () => {
    const d = fakeDeck();
    const cut = MOVE_PADS[3]!;
    cut.on(D(d));
    expect(d.cut).toBe(true);
    cut.off!(D(d));
    expect(d.cut).toBe(false);
    expect(d.calls).toEqual([]);
  });

  it("a received move fires on the receiver even when it sits in another bank", () => {
    const d = fakeDeck("cue");
    fireFxPadArg(D(d), "@moves:5", true);
    fireFxPadArg(D(d), "@moves:5", false);
    expect(d.calls).toEqual(["down freeze", "up freeze"]);
  });

  it("an empty slot on the wire does nothing", () => {
    const d = fakeDeck("cue");
    fireFxPadArg(D(d), "@moves:4", true);
    expect(d.calls).toEqual([]);
  });
});

describe("FX2 SHIFT + SPIN", () => {
  it("is a real backspin (playhead goes back), fired on the press, inert on release", () => {
    const d = fakeDeck();
    const r = fxPadPress(D(d), "Z", 0, true);
    expect(r).toMatchObject({ fired: true, alt: true });
    expect(fxPadRelease(D(d), "Z", 0)).toBe(false);
    expect(d.calls).toEqual(["spinback"]);
  });

  it("crosses the wire as its own gesture, so a co-DJ hears the real backspin too", () => {
    const d = fakeDeck("cue");
    fireFxPadArg(D(d), "@moves:0!", true);
    fireFxPadArg(D(d), "@moves:0!", false);
    expect(d.calls).toEqual(["spinback"]);
  });
});
