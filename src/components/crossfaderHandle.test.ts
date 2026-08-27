import { describe, expect, it } from "vitest";
import { HANDLE_W, handleCentre, isOnHandle } from "./Crossfader";

// A 1000px track. The handle is 38px and its centre travels from 19 to 981 — it never hangs off
// either end, which is why the throw is `w − HANDLE_W` and not `w`.
const W = 1000;

describe("handleCentre", () => {
  it("insets the travel by half a handle at each end", () => {
    expect(handleCentre(W, -1)).toBe(HANDLE_W / 2); // full A
    expect(handleCentre(W, 1)).toBe(W - HANDLE_W / 2); // full B
    expect(handleCentre(W, 0)).toBe(W / 2); // centre stays the centre
  });
  it("clamps a value that somehow left the range", () => {
    expect(handleCentre(W, -3)).toBe(HANDLE_W / 2);
    expect(handleCentre(W, 3)).toBe(W - HANDLE_W / 2);
  });
});

describe("isOnHandle", () => {
  it("covers the whole handle and not a pixel more", () => {
    expect(isOnHandle(500, W, 0)).toBe(true); // dead centre
    expect(isOnHandle(500 - HANDLE_W / 2, W, 0)).toBe(true); // its left edge
    expect(isOnHandle(500 + HANDLE_W / 2, W, 0)).toBe(true); // its right edge
    expect(isOnHandle(500 - HANDLE_W / 2 - 1, W, 0)).toBe(false); // one px outside is TRACK
    expect(isOnHandle(500 + HANDLE_W / 2 + 1, W, 0)).toBe(false);
  });
  it("follows the handle as the fader moves", () => {
    expect(isOnHandle(500, W, 0.5)).toBe(false); // the handle has left the middle
    expect(isOnHandle(handleCentre(W, 0.5), W, 0.5)).toBe(true);
  });
  it("still has a full-width target at the extremes", () => {
    expect(isOnHandle(0, W, -1)).toBe(true); // the very left edge of the track
    expect(isOnHandle(W, W, 1)).toBe(true);
  });
});
