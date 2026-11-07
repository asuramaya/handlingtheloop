import { describe, expect, it } from "vitest";
import { inTriangle } from "./menuAim";

// The menu-aim triangle: from where the pointer was, to the near edge of the open flyout. A point
// on the way there is "aiming"; a point that went straight down the list is not.
describe("menuAim inTriangle", () => {
  const from = { x: 100, y: 100 };
  const top = { x: 0, y: 80 }; // flyout to the LEFT, its right edge at x=0, spanning y 80..300
  const bottom = { x: 0, y: 300 };
  it("a diagonal step toward the flyout is inside", () => {
    expect(inTriangle({ x: 80, y: 120 }, from, top, bottom)).toBe(true);
  });
  it("a step straight down the list is outside", () => {
    expect(inTriangle({ x: 100, y: 130 }, from, top, bottom)).toBe(false);
  });
  it("a step away from the flyout is outside", () => {
    expect(inTriangle({ x: 120, y: 110 }, from, top, bottom)).toBe(false);
  });
});
