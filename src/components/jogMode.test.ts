import { describe, expect, it } from "vitest";
import { jogMode } from "./jogMode";

// ★ One answer for keyboard, MIDI and the on-screen arrows (operator, 2026-11-11: session sync audit).
describe("jogMode", () => {
  it("an armed boundary steps the edge, whatever else holds", () => {
    expect(jogMode({ adjusting: true, shift: true, loopActive: true })).toBe("adjust");
  });
  it("a LIVE loop travels, with or without SHIFT (the on-screen arrows used to beat-jump inside it)", () => {
    expect(jogMode({ adjusting: false, shift: false, loopActive: true })).toBe("move");
    expect(jogMode({ adjusting: false, shift: true, loopActive: false })).toBe("move");
  });
  it("otherwise it is a beat jump", () => {
    expect(jogMode({ adjusting: false, shift: false, loopActive: false })).toBe("jump");
  });
});
