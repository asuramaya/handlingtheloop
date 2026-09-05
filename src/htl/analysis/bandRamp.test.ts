import { describe, it, expect } from "vitest";
import { hexRGB, bandRamp, tiltLuma, luma, type RGB } from "./bandRamp";

// The stem-lane band ramp is what carries "which stem" and "what is in it" on two different
// channels at once. It only renders inside a canvas behind a separated track, which is exactly
// the kind of code that never gets checked — so the derivation lives in a pure module and the
// properties that make it READ are asserted here rather than eyeballed.

const STEM_DEFAULTS = {
  drums: "#ff5d73",
  bass: "#b06bff",
  vocals: "#5dff9e",
  other: "#36c2ff",
};

const hue = (c: RGB): number => {
  const [r, g, b] = c;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  if (mx === mn) return -1; // achromatic
  const d = mx - mn;
  let h: number;
  if (mx === r) h = ((g - b) / d) % 6;
  else if (mx === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
};

describe("hexRGB", () => {
  it("parses long and short form", () => {
    expect(hexRGB("#ff5d73")).toEqual([255, 93, 115]);
    expect(hexRGB("#f00")).toEqual([255, 0, 0]);
    expect(hexRGB("ff5d73")).toEqual([255, 93, 115]);
  });
  it("falls back to WHITE, not black, on garbage", () => {
    // A black fallback paints an invisible lane on a dark board — the failure would look like
    // "the stem didn't load" rather than "that colour is wrong".
    expect(hexRGB("#zzzzzz")).toEqual([255, 255, 255]);
    expect(hexRGB("")).toEqual([255, 255, 255]);
  });
});

describe("bandRamp", () => {
  it("keeps the picked colour as the MID stop, exactly", () => {
    // The colour the user chose in Settings has to be the one they actually see — the ramp
    // varies around it, it does not replace it.
    for (const hex of Object.values(STEM_DEFAULTS)) {
      expect(bandRamp(hex)[1]).toEqual(hexRGB(hex));
    }
  });

  it("orders the three stops dark → base → light", () => {
    // This ordering IS the nesting: a deep body, the colour, a bright core. Reverse it and the
    // lane reads inside-out.
    for (const hex of Object.values(STEM_DEFAULTS)) {
      const [lo, mid, hi] = bandRamp(hex);
      expect(luma(lo)).toBeLessThan(luma(mid));
      expect(luma(mid)).toBeLessThan(luma(hi));
    }
  });

  it("holds the stem's hue across all three stops", () => {
    // The whole point: hue answers "which stem". If a stop drifts in hue, the lane stops being
    // one colour family and starts competing with the global band palette it replaced.
    for (const hex of Object.values(STEM_DEFAULTS)) {
      const [lo, mid, hi] = bandRamp(hex);
      const h = hue(mid);
      for (const stop of [lo, hi]) {
        const dh = Math.abs(hue(stop) - h);
        expect(Math.min(dh, 360 - dh)).toBeLessThan(1);
      }
    }
  });

  it("keeps distinct stems distinct at every stop", () => {
    // Four lanes stacked in one viewport: if two stems' bodies converge, the quad view stops
    // telling you which is which — the exact failure the shared global palette had.
    const names = Object.keys(STEM_DEFAULTS) as (keyof typeof STEM_DEFAULTS)[];
    const ramps = names.map((n) => bandRamp(STEM_DEFAULTS[n]));
    for (let stop = 0; stop < 3; stop++) {
      for (let i = 0; i < ramps.length; i++) {
        for (let j = i + 1; j < ramps.length; j++) {
          const a = ramps[i][stop], b = ramps[j][stop];
          const d = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
          expect(d).toBeGreaterThan(24);
        }
      }
    }
  });

  it("stays in gamut", () => {
    for (const hex of [...Object.values(STEM_DEFAULTS), "#000000", "#ffffff"]) {
      for (const stop of bandRamp(hex)) {
        for (const ch of stop) {
          expect(ch).toBeGreaterThanOrEqual(0);
          expect(ch).toBeLessThanOrEqual(255);
        }
      }
    }
  });

  it("keeps a VISIBLE step at the ends of the range, where one direction has nowhere to go", () => {
    // A user can pick #000 or #fff for a stem. Black cannot be darkened and white cannot be
    // lightened, so on those inputs one adjacent pair genuinely collapses (black's low == its
    // mid). That is accepted, not overlooked: the MID stop must stay exactly the colour that was
    // picked, and the remaining stop still separates, so the lane keeps a readable core or body
    // rather than going flat. Asserted in the direction that must survive.
    const black = bandRamp("#000000");
    const white = bandRamp("#ffffff");
    expect(luma(black[2])).toBeGreaterThan(luma(black[1])); // black still gets a bright core
    expect(luma(white[0])).toBeLessThan(luma(white[1])); // white still gets a dark body
  });
});

describe("tiltLuma — depth for three independently-picked hues", () => {
  // The shipped band defaults, which are the case that exposed this: magenta / yellow / green.
  const DEFAULTS: [string, string, string] = ["#f13194", "#d5ef2d", "#4ef64b"];

  it("the untilted defaults really are out of order — that is the bug, not a hypothetical", () => {
    const [lo, mid, hi] = DEFAULTS.map(hexRGB) as [RGB, RGB, RGB];
    expect(luma(lo)).toBeLessThan(luma(mid));
    expect(luma(hi)).toBeLessThan(luma(mid)); // the CORE is darker than the BODY it sits on
  });

  it("orders them dark → base → bright, so the core reads on top", () => {
    const [lo, mid, hi] = tiltLuma(DEFAULTS.map(hexRGB) as [RGB, RGB, RGB]);
    expect(luma(lo)).toBeLessThan(luma(mid));
    expect(luma(mid)).toBeLessThan(luma(hi));
  });

  it("moves lightness only — every hue survives exactly", () => {
    // Hue is what a user actually picks a colour FOR. Depth is carried by luminance, so that is
    // the only channel this is allowed to touch.
    const before = DEFAULTS.map(hexRGB) as [RGB, RGB, RGB];
    const after = tiltLuma(before);
    for (let i = 0; i < 3; i++) {
      const dh = Math.abs(hue(after[i]) - hue(before[i]));
      expect(Math.min(dh, 360 - dh)).toBeLessThan(1);
    }
  });

  it("leaves the mid stop untouched", () => {
    const before = DEFAULTS.map(hexRGB) as [RGB, RGB, RGB];
    expect(tiltLuma(before)[1]).toEqual(before[1]);
  });

  it("still orders correctly for hues picked in a deliberately awkward order", () => {
    // A user can pick a near-white low and a near-black high. The tilt cannot invent contrast
    // that the choices removed, but it must never make the ordering WORSE than it found it.
    const awkward: [RGB, RGB, RGB] = [hexRGB("#eeeeff"), hexRGB("#808080"), hexRGB("#221100")];
    const [lo, mid, hi] = tiltLuma(awkward);
    expect(luma(lo)).toBeLessThan(luma(awkward[0]));
    expect(luma(hi)).toBeGreaterThan(luma(awkward[2]));
    expect(mid).toEqual(awkward[1]);
  });
});
