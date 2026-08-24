import { describe, expect, it } from "vitest";
import { insertionToIndex, pickInsertion } from "./useReorderDrag";

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
