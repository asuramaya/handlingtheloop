import { describe, expect, it } from "vitest";
import { fxPadPress, fxPadRelease } from "./fxPads";
import type { Deck } from "@htl/audio";

// Operator, 2026-11-06: "letting them be hot by default and toggle on shifted mode may make more
// sense". Plain press = ON only while held (no timing rule), SHIFT+press = toggle the latch.
// A deck double with one ECHO device on the pad chain: the throw flag and the bypass are the two
// ways an effect can be sounding (fxPadIsOn reads both).
function deckWithEcho() {
  const dev = { kind: "delay", bypassed: true, latched: 0, setBypass(b: boolean) { this.bypassed = b; }, latchThrow() { this.latched++; this.bypassed = false; } };
  const deck = {
    echoing: false,
    padChain: "master",
    echoOut(on: boolean) { this.echoing = on; },
    get echoingOut() { return this.echoing; },
    fxChain: () => ({ devices: [dev] }),
  };
  const on = () => deck.echoing || !dev.bypassed;
  return { deck: deck as unknown as Deck, dev, on };
}

describe("FX pads: hot by default, SHIFT latches", () => {
  it("a plain press is on while held and off on release, however long or short", () => {
    const { deck, on } = deckWithEcho();
    expect(fxPadPress(deck, "A", 0).fired).toBe(true);
    expect(on()).toBe(true);
    expect(fxPadRelease(deck, "A", 0)).toBe(true); // an instant tap still lets go
    expect(on()).toBe(false);
  });

  it("SHIFT+press latches at once (at the dialled settings) and the release leaves it on", () => {
    const { deck, dev, on } = deckWithEcho();
    expect(fxPadPress(deck, "A", 0, true).fired).toBe(true);
    expect(dev.latched).toBe(1);
    expect(fxPadRelease(deck, "A", 0)).toBe(false);
    expect(on()).toBe(true);
  });

  it("SHIFT+press on a latched pad turns it off", () => {
    const { deck, on } = deckWithEcho();
    fxPadPress(deck, "A", 0, true);
    fxPadRelease(deck, "A", 0);
    const r = fxPadPress(deck, "A", 0, true);
    expect(r.off).toBe(true);
    expect(on()).toBe(false);
    expect(fxPadRelease(deck, "A", 0)).toBe(false);
  });

  it("a plain press on a latched pad plays through it and takes it out on release", () => {
    const { deck, on } = deckWithEcho();
    fxPadPress(deck, "A", 0, true);
    fxPadRelease(deck, "A", 0);
    expect(fxPadPress(deck, "A", 0).fired).toBe(false); // already sounding: nothing new fires
    expect(on()).toBe(true);
    expect(fxPadRelease(deck, "A", 0)).toBe(true);
    expect(on()).toBe(false);
  });
});
