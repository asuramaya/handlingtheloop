// Band colour anchors for the waveform renderer — pure, so they are testable without a canvas.
//
// ★ A STEM LANE'S BANDS COME FROM ITS OWN HUE. Every lane used to be painted in the ONE global
// low/mid/high palette, and the per-stem colours were consulted only when frequency colour was
// OFF — so you could know which lane was which, or see what was inside it, never both. The two
// facts sit on different axes and should ride different channels: HUE says WHICH stem, the
// nested lobes say WHAT IS IN IT. So each lane derives a three-stop ramp from its own colour —
// a deep body, the colour itself, a near-white core — while the global Lows/Mids/Highs go on
// meaning what they always did for the collapsed mix, which has no stem identity to carry.

export type RGB = [number, number, number];

/** "#rgb" / "#rrggbb" → [r,g,b]. Anything unparseable falls back to white rather than black,
 *  so a bad value shows up as an obviously wrong lane instead of an invisible one. */
export function hexRGB(hex: string): RGB {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const n = parseInt(h, 16);
  return Number.isNaN(n) || h.length !== 6 ? [255, 255, 255] : [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export const RAMP_DARK = 0.35; // how far the low band sinks toward black (the body — the largest area)
// How far the high band climbs toward white. Deliberately GENTLE: the layered renderer composites
// the lobes additively, so an overlap already brightens on its own — pre-lightening the core as
// well double-pays for the same effect and lands it on pure white, where the mix of bands that
// produced it is no longer legible (measured: 86% of columns clipped, core saturation 0.07).
// The ramp supplies contrast; the compositing supplies the glow.
export const RAMP_LIGHT = 0.3;
// The FLAT renderer has no compositing to lean on, so ordering has to be baked into the colours
// themselves — see tiltLuma, which keeps the stronger lift for exactly that case.
export const TILT_LIGHT = 0.72;

function mixRGB(c: RGB, t: number, k: number): RGB {
  return [c[0] + (t - c[0]) * k, c[1] + (t - c[1]) * k, c[2] + (t - c[2]) * k];
}

/** Three stops from one colour: [low, mid, high] — darker, the colour, lighter. Mixing toward
 *  black and white (rather than rotating hue) is what keeps all three recognisably the SAME
 *  stem: the lane reads as one colour family whose interior happens to have structure. */
export function bandRamp(hex: string): [RGB, RGB, RGB] {
  const base = hexRGB(hex);
  return [mixRGB(base, 0, RAMP_DARK), base, mixRGB(base, 255, RAMP_LIGHT)];
}

/** Rec.601 luma — the ordering the ramp must preserve for the nesting to read. */
export function luma(c: RGB): number {
  return 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
}

/** The SAME depth ramp, applied to three hues that were picked independently.
 *
 *  `bandRamp` gets luminance ordering for free because all three stops come from one colour.
 *  The mix's Lows/Mids/Highs do not: they are three separate choices, and nothing stops them
 *  landing in the wrong order. The shipped defaults do exactly that — magenta 118, green 176,
 *  yellow 209 — so the MID is the brightest thing on screen and the "bright core" the layered
 *  renderer draws on top is DARKER than the body underneath it. The nesting is still there,
 *  but it reads inside-out, which is why a layered mix looked like a flat saturated mass while
 *  the stem lanes beside it read as having depth.
 *
 *  Depth is carried by LUMINANCE; hue is what the user actually picked a colour FOR. So each
 *  anchor keeps its hue exactly and only its lightness is moved: the body sinks, the core
 *  climbs, the mid is left alone. Same constants as bandRamp, for the same reason. */
export function tiltLuma(cols: [RGB, RGB, RGB]): [RGB, RGB, RGB] {
  const [lo, mid, hi] = cols;
  return [mixRGB(lo, 0, RAMP_DARK), mid, mixRGB(hi, 255, TILT_LIGHT)];
}
