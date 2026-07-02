// The pure parts of the album-art palette pipeline: median-cut quantiser, the accent/band chooser,
// and the codec. extractPalette (canvas/DOM) is browser-only and out of scope here.
import { describe, it, expect } from "vitest";
import { quantize, paletteFrom, serializePalette, deserializePalette, rgbHex, neonAccent, neonHex, type RGB, type Palette } from "./palette";

describe("rgbHex", () => {
  it("formats, clamps, and rounds to #rrggbb", () => {
    expect(rgbHex([255, 0, 128])).toBe("#ff0080");
    expect(rgbHex([0, 0, 0])).toBe("#000000");
    expect(rgbHex([300, -5, 127.6])).toBe("#ff0080"); // clamp to 255/0, round 127.6→128
  });
});

describe("quantize (median cut)", () => {
  it("returns [] for empty input", () => {
    expect(quantize([], 6)).toEqual([]);
  });
  it("collapses a single colour to that colour", () => {
    const px: RGB[] = Array.from({ length: 20 }, () => [10, 200, 30] as RGB);
    const q = quantize(px, 6);
    expect(q.length).toBe(1);
    expect(q[0].map((n) => Math.round(n))).toEqual([10, 200, 30]);
  });
  it("separates two well-separated equal clusters", () => {
    const px: RGB[] = [
      ...Array.from({ length: 20 }, () => [240, 10, 10] as RGB),
      ...Array.from({ length: 20 }, () => [10, 10, 240] as RGB),
    ];
    const q = quantize(px, 2);
    expect(q.length).toBe(2);
    const hasRed = q.some((c) => c[0] > 200 && c[2] < 60);
    const hasBlue = q.some((c) => c[2] > 200 && c[0] < 60);
    expect(hasRed && hasBlue).toBe(true);
  });
  it("never returns more than `max` colours", () => {
    const px: RGB[] = Array.from({ length: 100 }, (_, i) => [(i * 2) % 256, (255 - i) % 256, (i * 3) % 256] as RGB);
    expect(quantize(px, 4).length).toBeLessThanOrEqual(4);
  });
});

describe("paletteFrom", () => {
  it("returns null for no colours", () => {
    expect(paletteFrom([])).toBeNull();
  });
  it("returns four #rrggbb colours", () => {
    const p = paletteFrom([[240, 30, 30], [30, 30, 200], [200, 200, 40]])!;
    for (const k of ["accent", "low", "mid", "high"] as const) expect(p[k]).toMatch(/^#[0-9a-f]{6}$/);
  });
  it("picks a vivid accent, not near-black / near-white / grey", () => {
    const p = paletteFrom([[250, 20, 20], [8, 8, 8], [250, 250, 250], [128, 128, 128]])!;
    expect(p.accent).toBe("#fa1414"); // the saturated red
  });
  it("derives distinct band shades from monochromatic art (low ≠ high)", () => {
    const p = paletteFrom([[120, 40, 40]])!;
    expect(p.low).not.toBe(p.high);
  });
});

describe("neonAccent / neonHex (legible accent floor)", () => {
  const lum = (c: RGB) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
  it("brightens a near-black accent so it's legible on a dark UI", () => {
    const dark: RGB = [15, 12, 45];
    expect(lum(neonAccent(dark))).toBeGreaterThan(lum(dark) + 30);
  });
  it("pulls a near-white accent down out of the wash", () => {
    expect(lum(neonAccent([252, 252, 255]))).toBeLessThan(lum([252, 252, 255]));
  });
  it("keeps a grey grey — never invents a hue", () => {
    const out = neonAccent([40, 40, 40]);
    expect(Math.max(...out) - Math.min(...out)).toBeLessThan(12);
  });
  it("saturates a muted hue so it still pops", () => {
    const out = neonAccent([120, 100, 100]);
    expect((Math.max(...out) - Math.min(...out)) / Math.max(...out)).toBeGreaterThan(0.4);
  });
  it("neonHex passes a non-#rrggbb value through unchanged", () => {
    expect(neonHex("red")).toBe("red");
    expect(neonHex("#fff")).toBe("#fff");
  });
  it("neonHex returns a valid #rrggbb for a hex input", () => {
    expect(neonHex("#0a0a28")).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe("palette codec", () => {
  const p: Palette = { accent: "#ff8800", low: "#112233", mid: "#445566", high: "#aabbcc" };
  it("round-trips serialize → deserialize", () => {
    expect(deserializePalette(serializePalette(p))).toEqual(p);
  });
  it("returns null on empty / malformed / non-hex / incomplete", () => {
    expect(deserializePalette(null)).toBeNull();
    expect(deserializePalette("")).toBeNull();
    expect(deserializePalette("nope{")).toBeNull();
    expect(deserializePalette(JSON.stringify({ a: "#fff", l: "#112233", m: "#445566", h: "#aabbcc" }))).toBeNull(); // #fff is not 6-digit
    expect(deserializePalette(JSON.stringify({ a: "red", l: "#112233", m: "#445566", h: "#aabbcc" }))).toBeNull();
    expect(deserializePalette(JSON.stringify({ a: "#ff8800" }))).toBeNull(); // missing l/m/h
  });
});
