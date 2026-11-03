import { describe, expect, it } from "vitest";
import { naturalStackHeight } from "./useDeckStackHeight";

// A stand-in for `.bank-main`: its scrollHeight is never below its own min-height, exactly like the
// real element, because the floor it is measured against IS the value being published.
function fakeStack(rowsPx: number, floorPx: number) {
  const style = { minHeight: `${floorPx}px` };
  return {
    style,
    get scrollHeight() {
      const floor = parseFloat(style.minHeight) || 0;
      return Math.max(rowsPx, floor);
    },
  } as unknown as HTMLElement;
}

describe("deck stack height", () => {
  it("measures the ROWS, not the stale floor: a deck that once measured 520px returns to its real 369px", () => {
    const el = fakeStack(369, 520);
    expect(naturalStackHeight(el)).toBe(369);
  });

  it("leaves the floor exactly as it found it (the read must not repaint anything)", () => {
    const el = fakeStack(369, 520);
    naturalStackHeight(el);
    expect(el.style.minHeight).toBe("520px");
  });

  it("CONTROL: the old read (scrollHeight with the floor on) is the ratchet this replaces", () => {
    expect(fakeStack(369, 520).scrollHeight).toBe(520);
  });
});
