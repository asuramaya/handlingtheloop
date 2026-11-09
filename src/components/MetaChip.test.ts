import { describe, expect, it } from "vitest";
import { camelotOf, keyHue } from "./MetaChip";

describe("MetaChip key colour", () => {
  it("reads Camelot codes and musical names to the same wheel position", () => {
    expect(camelotOf("8A")).toEqual({ num: 8, minor: true });
    expect(camelotOf("12B")).toEqual({ num: 12, minor: false });
    expect(camelotOf("Am")).toEqual({ num: 8, minor: true });
    expect(camelotOf("C")).toEqual({ num: 8, minor: false });
    expect(camelotOf("F#m")).toEqual({ num: 11, minor: true });
    expect(camelotOf("—")).toBeNull();
    expect(camelotOf("13A")).toBeNull();
    expect(camelotOf(null)).toBeNull();
  });
  it("relative keys share a hue; wheel neighbours are 30° apart", () => {
    expect(keyHue("8A")).toBe(keyHue("8B"));
    const d = Math.abs((keyHue("9A") ?? 0) - (keyHue("8A") ?? 0));
    expect(Math.min(d, 360 - d)).toBe(30);
  });
});
