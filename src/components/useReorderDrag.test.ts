import { describe, expect, it } from "vitest";
import { insertionToIndex, pickInsertion, isIntoTarget } from "./useReorderDrag";

// Four items 100 px wide, so centres at 50, 150, 250, 350.
const CENTERS = [50, 150, 250, 350];

describe("pickInsertion", () => {
  it("reads the gap the pointer is in", () => {
    expect(pickInsertion(CENTERS, 10, 3)).toBe(0); // left of everything
    expect(pickInsertion(CENTERS, 140, 3)).toBe(1);
    expect(pickInsertion(CENTERS, 160, 3)).toBe(2);
    expect(pickInsertion(CENTERS, 999, 0)).toBe(4); // past the last item
  });
  it("refuses the two gaps either side of the dragged item", () => {
    // Item 1 is being dragged: gaps 1 and 2 both leave it exactly where it is.
    expect(pickInsertion(CENTERS, 140, 1)).toBeNull();
    expect(pickInsertion(CENTERS, 160, 1)).toBeNull();
    expect(pickInsertion(CENTERS, 260, 1)).toBe(3); // genuinely elsewhere
  });
  it("has no drop at all in an empty row", () => {
    expect(pickInsertion([], 100, 0)).toBeNull(); // gap 0 == self 0
  });
});

describe("insertionToIndex", () => {
  it("leaves a leftward move alone", () => {
    expect(insertionToIndex(3, 1)).toBe(1);
    expect(insertionToIndex(3, 0)).toBe(0);
  });
  it("shifts a rightward move down one, because the source leaves first", () => {
    expect(insertionToIndex(0, 3)).toBe(2);
    expect(insertionToIndex(1, 4)).toBe(3); // dropped past the last of four → last slot
  });
  it("round-trips a no-op", () => {
    expect(insertionToIndex(2, 2)).toBe(2);
    expect(insertionToIndex(2, 3)).toBe(2);
  });
});

// A section heading is BOTH a draggable row and a drop-into target. Covering all of it with "into"
// is what made reordering around a section impossible — the only route to the gap beside it is
// across the heading itself.
describe("isIntoTarget", () => {
  it("gives the middle to INTO and both ends to the gaps", () => {
    expect(isIntoTarget(13, 26)).toBe(true); // dead centre
    expect(isIntoTarget(1, 26)).toBe(false); // top edge → insert before
    expect(isIntoTarget(25, 26)).toBe(false); // bottom edge → insert after
  });
  it("keeps a usable middle on a short row", () => {
    // 26px heading: 6.5px each end, 13px of into — the real case.
    expect(isIntoTarget(7, 26)).toBe(true);
    expect(isIntoTarget(6, 26)).toBe(false);
  });
  it("caps the band so a tall row does not lose a quarter at each end", () => {
    expect(isIntoTarget(10, 200)).toBe(true); // 9px cap, not 50px
    expect(isIntoTarget(8, 200)).toBe(false);
  });
});

// ★ A FOREIGN LIST IS ASKED WHERE, AND NOTHING IN IT IS "WHERE IT ALREADY IS". hitTest measures a
// drop-list live and calls pickInsertion with self = -2 for exactly this reason: -1 would make
// `p === self + 1` true at gap 0 and silently refuse the top of the list, which is the one gap a
// row leaving a group most obviously wants.
describe("pickInsertion into a list nothing is being dragged out of", () => {
  const CS = [110, 150, 190, 230];
  it("offers every gap, including the first", () => {
    expect(pickInsertion(CS, 10, -2)).toBe(0);
    expect(pickInsertion(CS, 130, -2)).toBe(1);
    expect(pickInsertion(CS, 999, -2)).toBe(4);
  });
  it("self = -1 would have suppressed gap 0 — the bug this guards", () => {
    expect(pickInsertion(CS, 10, -1)).toBeNull();
  });
});
