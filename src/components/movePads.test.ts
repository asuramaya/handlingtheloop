import { describe, expect, it } from "vitest";
import { MOVE_PADS } from "./movePads";
import { fireFxPadArg, fxPadPress, fxPadRelease, padsForDeck } from "./fxPads";
import type { Deck } from "@htl/audio";

// FX2 (operator, 2026-11-07): FREEZE · CENSOR · BRAKE · CUT / SPIN · DRAG · PUSH · RUB, one rule for
// all eight: plain = SLIP (lands on the beat), SHIFT = COMMIT (the track stays where the move took it).
function fakeDeck(padMode = "fx2") {
  const held = new Set<string>();
  return {
    padMode,
    calls: [] as string[],
    cut: false,
    paused: false,
    moveDown(k: string, commit = false) { this.calls.push(`down ${k}${commit ? " commit" : ""}`); held.add(k); },
    moveUp(k: string) { this.calls.push(`up ${k}`); held.delete(k); },
    moveHeld: (k: string) => held.has(k),
    setCut(on: boolean) { this.cut = on; },
    get cutting(): boolean { return this.cut; },
    cutPause(on: boolean) { this.paused = on; this.calls.push(`pause ${on}`); },
    get cutPaused(): boolean { return this.paused; },
  };
}
const D = (d: ReturnType<typeof fakeDeck>) => d as unknown as Deck;
const LABELS = ["FREEZE", "CENSOR", "BRAKE", "CUT", "SPIN", "DRAG", "PUSH", "RUB"];
const KINDS = ["freeze", "censor", "brake", null, "spin", "drag", "push", "rub"];

describe("FX2: plain = slip, SHIFT = commit, on every pad", () => {
  it("the bank", () => {
    expect(padsForDeck(D(fakeDeck())).map((p) => p?.label ?? null)).toEqual(LABELS);
  });

  it("every move pad: plain holds the slip move, SHIFT holds the SAME move committed", () => {
    KINDS.forEach((k, i) => {
      if (!k) return;
      const d = fakeDeck();
      fxPadPress(D(d), "Y", i);
      expect(fxPadRelease(D(d), "Y", i)).toBe(true);
      expect(fxPadPress(D(d), "Y", i, true)).toMatchObject({ fired: true, alt: true });
      expect(fxPadRelease(D(d), "Y", i)).toBe("alt");
      expect(d.calls).toEqual([`down ${k}`, `up ${k}`, `down ${k} commit`, `up ${k}`]);
    });
  });

  it("CUT: plain mutes while the track runs on; SHIFT is a real pause", () => {
    const d = fakeDeck();
    fxPadPress(D(d), "C", 3);
    expect(d.cut).toBe(true);
    fxPadRelease(D(d), "C", 3);
    expect(d.cut).toBe(false);
    fxPadPress(D(d), "C", 3, true);
    expect(d.paused).toBe(true);
    fxPadRelease(D(d), "C", 3);
    expect(d.calls).toEqual(["pause true", "pause false"]);
  });

  it("SHIFT never latches on this bank: the release always ends the move", () => {
    const d = fakeDeck();
    fxPadPress(D(d), "L", 1, true);
    expect(fxPadRelease(D(d), "L", 1)).toBe("alt");
    expect(d.calls).toEqual(["down censor commit", "up censor"]);
  });

  it("both layers cross the wire: a co-DJ hears the slip or the commit you played", () => {
    const d = fakeDeck("cue");
    fireFxPadArg(D(d), "@moves:5", true);
    fireFxPadArg(D(d), "@moves:5", false);
    fireFxPadArg(D(d), "@moves:6!", true);
    fireFxPadArg(D(d), "@moves:6!", false);
    expect(d.calls).toEqual(["down drag", "up drag", "down push commit", "up push"]);
  });

  it("a move pad lights while its move sounds", () => {
    const d = fakeDeck();
    const brake = MOVE_PADS[2]!;
    brake.on(D(d));
    expect(brake.active!(D(d))).toBe(true);
    brake.off!(D(d));
    expect(brake.active!(D(d))).toBe(false);
  });
});
