import { describe, it, expect } from "vitest";
import { clampByte, byteToHex, hexToRgb } from "./color";

describe("clampByte", () => {
  it("clamps negatives to 0", () => {
    expect(clampByte(-1)).toBe(0);
    expect(clampByte(-100)).toBe(0);
  });
  it("clamps > 255 to 255", () => {
    expect(clampByte(256)).toBe(255);
    expect(clampByte(1000)).toBe(255);
  });
  it("rounds to nearest integer", () => {
    expect(clampByte(127.4)).toBe(127);
    expect(clampByte(127.6)).toBe(128);
    expect(clampByte(0.5)).toBe(1); // Math.round half-up
  });
  it("passes valid in-range values", () => {
    expect(clampByte(0)).toBe(0);
    expect(clampByte(128)).toBe(128);
    expect(clampByte(255)).toBe(255);
  });
});

describe("byteToHex", () => {
  it("maps 0 to '00'", () => {
    expect(byteToHex(0)).toBe("00");
  });
  it("maps 255 to 'ff'", () => {
    expect(byteToHex(255)).toBe("ff");
  });
  it("zero-pads single hex digits", () => {
    expect(byteToHex(5)).toBe("05");
    expect(byteToHex(15)).toBe("0f");
    expect(byteToHex(16)).toBe("10");
  });
  it("clamps and rounds out-of-range inputs", () => {
    expect(byteToHex(-5)).toBe("00");
    expect(byteToHex(300)).toBe("ff");
    expect(byteToHex(127.6)).toBe("80"); // rounds to 128
  });
});

describe("hexToRgb", () => {
  it("parses full 6-digit white", () => {
    expect(hexToRgb("#ffffff")).toEqual([255, 255, 255]);
  });
  it("expands 3-digit short form black", () => {
    expect(hexToRgb("#000")).toEqual([0, 0, 0]);
  });
  it("expands 3-digit short form to doubled channels", () => {
    expect(hexToRgb("#f0a")).toEqual([255, 0, 170]); // ff, 00, aa
  });
  it("parses a known mid colour", () => {
    expect(hexToRgb("#336699")).toEqual([51, 102, 153]);
  });
  it("works without a leading #", () => {
    expect(hexToRgb("ff0000")).toEqual([255, 0, 0]);
  });
  it("falls back to [5,5,7] on malformed input", () => {
    expect(hexToRgb("#xyz")).toEqual([5, 5, 7]); // 3->6 chars but NaN
    expect(hexToRgb("#12")).toEqual([5, 5, 7]); // wrong length
    expect(hexToRgb("#1234567")).toEqual([5, 5, 7]); // too long
    expect(hexToRgb("")).toEqual([5, 5, 7]);
  });
});
