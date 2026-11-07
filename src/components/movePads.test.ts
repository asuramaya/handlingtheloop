import { describe, expect, it } from "vitest";
import { MOVE_PADS } from "./movePads";
import { fireFxPadArg, padsForDeck } from "./fxPads";
import type { Deck } from "@htl/audio";

// FX2 = deck moves (operator, 2026-11-07): SPIN · CENSOR · BRAKE, the rest to be decided.
function fakeDeck(padMode = "fx2") {
  return {
    padMode,
    calls: [] as string[],
    braking: false,
    brakeBegin() { this.calls.push("brakeBegin"); this.braking = true; },
    brakeEnd() { this.calls.push("brakeEnd"); this.braking = false; },
    pause() { this.calls.push("pause"); },
    spinBegin() { this.calls.push("spinBegin"); },
    spinEnd() { this.calls.push("spinEnd"); },
  };
}

describe("FX2 SPIN", () => {
  it("is a held slip move too: backspin on press, land on the beat on release", () => {
    const d = fakeDeck();
    const spin = MOVE_PADS[0]!;
    expect(spin.hold).toBe(true);
    spin.on(d as unknown as Deck);
    spin.off!(d as unknown as Deck);
    expect(d.calls).toEqual(["spinBegin", "spinEnd"]);
  });
});

describe("FX2 moves", () => {
  it("FX2 holds SPIN, CENSOR and BRAKE; the other five slots are empty", () => {
    expect(padsForDeck(fakeDeck() as unknown as Deck).map((p) => p?.label ?? null)).toEqual(["SPIN", "CENSOR", "BRAKE", null, null, null, null, null]);
  });

  it("BRAKE is a held slip overlay: brakeBegin on press, brakeEnd on release, and it never pauses", () => {
    const d = fakeDeck();
    const brake = MOVE_PADS[2]!;
    expect(brake.hold).toBe(true);
    brake.on(d as unknown as Deck);
    expect(brake.active!(d as unknown as Deck)).toBe(true);
    brake.off!(d as unknown as Deck);
    expect(d.calls).toEqual(["brakeBegin", "brakeEnd"]);
  });

  it("a received move fires on the receiver even when it sits in another bank", () => {
    const d = fakeDeck("cue");
    fireFxPadArg(d as unknown as Deck, "@moves:2", true);
    fireFxPadArg(d as unknown as Deck, "@moves:2", false);
    expect(d.calls).toEqual(["brakeBegin", "brakeEnd"]);
  });

  it("an empty slot on the wire does nothing", () => {
    const d = fakeDeck("cue");
    fireFxPadArg(d as unknown as Deck, "@moves:6", true);
    expect(d.calls).toEqual([]);
  });
});
