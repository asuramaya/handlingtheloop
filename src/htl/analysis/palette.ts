// Per-track colour palette extracted from the (now same-origin, canvas-untainted) album art.
// Rides the crowdsourced analysis convergence lane like bpm/key/grid: extracted once client-side,
// stored in D1, served instantly to every device. Drives per-track UI theming (deck accent +
// optional waveform band hues). Pure quantiser/chooser/codec here are testable; extractPalette is
// the browser entry (canvas — DOM-only). See htl-album-art.

export type RGB = [number, number, number];

/** Four hex colours the UI themes to: `accent` (deck highlight) + a low/mid/high band spread
 *  (waveform freq hues). All `#rrggbb`. */
export interface Palette {
  accent: string;
  low: string;
  mid: string;
  high: string;
}

const clamp8 = (n: number): number => (n < 0 ? 0 : n > 255 ? 255 : Math.round(n));
const hex2 = (n: number): string => clamp8(n).toString(16).padStart(2, "0");
export const rgbHex = (c: RGB): string => `#${hex2(c[0])}${hex2(c[1])}${hex2(c[2])}`;

/** Perceptual-ish luminance (Rec.601), 0..255. */
function lum(c: RGB): number {
  return 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
}

/** How "poppy" a colour is: saturation × a mid-luminance weight, so the accent is a vivid colour,
 *  not a near-black, near-white, or grey. 0..~1. */
function vibrancy(c: RGB): number {
  const max = Math.max(c[0], c[1], c[2]);
  const min = Math.min(c[0], c[1], c[2]);
  const sat = max === 0 ? 0 : (max - min) / max;
  const l = lum(c) / 255;
  const midWeight = 1 - Math.abs(l - 0.5) * 2; // peaks at mid-luminance, 0 at pure black/white
  return sat * (0.35 + 0.65 * midWeight);
}

function mix(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}
const darken = (c: RGB, t: number): RGB => mix(c, [0, 0, 0], t);
const lighten = (c: RGB, t: number): RGB => mix(c, [255, 255, 255], t);

// Widest colour axis of a box + its range, for the median-cut split.
function boxAxis(box: RGB[]): { axis: 0 | 1 | 2; range: number } {
  const lo: RGB = [255, 255, 255];
  const hi: RGB = [0, 0, 0];
  for (const p of box)
    for (let k = 0; k < 3; k++) {
      if (p[k] < lo[k]) lo[k] = p[k];
      if (p[k] > hi[k]) hi[k] = p[k];
    }
  let axis: 0 | 1 | 2 = 0;
  let range = hi[0] - lo[0];
  if (hi[1] - lo[1] > range) {
    axis = 1;
    range = hi[1] - lo[1];
  }
  if (hi[2] - lo[2] > range) {
    axis = 2;
    range = hi[2] - lo[2];
  }
  return { axis, range };
}

function avgColor(box: RGB[]): RGB {
  let r = 0,
    g = 0,
    b = 0;
  for (const p of box) {
    r += p[0];
    g += p[1];
    b += p[2];
  }
  const n = box.length || 1;
  return [r / n, g / n, b / n];
}

/** Median-cut quantisation → up to `max` dominant colours, most-populous first. Repeatedly splits
 *  the box with the widest colour axis at its median until `max` boxes; each box's mean is a colour. */
export function quantize(pixels: RGB[], max: number): RGB[] {
  if (!pixels.length || max < 1) return [];
  let boxes: RGB[][] = [pixels.slice()];
  while (boxes.length < max) {
    let bi = -1;
    let best = 0;
    for (let i = 0; i < boxes.length; i++) {
      if (boxes[i].length < 2) continue;
      const r = boxAxis(boxes[i]).range;
      if (r > best) {
        best = r;
        bi = i;
      }
    }
    if (bi < 0) break; // every box is a single colour
    const box = boxes[bi];
    const { axis } = boxAxis(box);
    box.sort((a, b) => a[axis] - b[axis]);
    const mid = box.length >> 1;
    boxes.splice(bi, 1, box.slice(0, mid), box.slice(mid));
  }
  return boxes
    .map((b) => ({ c: avgColor(b), pop: b.length }))
    .sort((a, b) => b.pop - a.pop)
    .map((x) => x.c);
}

/** Choose the themeable palette from quantised dominant colours: the most vibrant becomes `accent`;
 *  three colours spread by luminance become low/mid/high (darkest→low). Monochromatic art (no
 *  spread) derives the bands as shades of the accent so they never collapse to one hue. */
export function paletteFrom(colors: RGB[]): Palette | null {
  if (!colors.length) return null;
  const accent = colors.slice().sort((a, b) => vibrancy(b) - vibrancy(a))[0];
  // Band colours: prefer 3 distinct dominant colours; if the art is near-monochromatic, use shades
  // of the accent so low/mid/high stay visually distinct.
  const byLum = colors.slice().sort((a, b) => lum(a) - lum(b));
  const spread = lum(byLum[byLum.length - 1]) - lum(byLum[0]);
  const band: RGB[] =
    colors.length >= 3 && spread > 40
      ? [byLum[0], byLum[byLum.length >> 1], byLum[byLum.length - 1]]
      : [darken(accent, 0.45), accent, lighten(accent, 0.45)];
  return { accent: rgbHex(accent), low: rgbHex(band[0]), mid: rgbHex(band[1]), high: rgbHex(band[2]) };
}

function hexRgb(hex: string): RGB | null {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHsl([r, g, b]: RGB): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  const l = (max + min) / 2;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
    if (h < 0) h += 1;
  }
  return [h, s, l];
}

function hslToRgb([h, s, l]: [number, number, number]): RGB {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h * 6) % 2) - 1));
  const m = l - c / 2;
  const hh = h * 6;
  let r = 0;
  let g = 0;
  let b = 0;
  if (hh < 1) [r, g] = [c, x];
  else if (hh < 2) [r, g] = [x, c];
  else if (hh < 3) [g, b] = [c, x];
  else if (hh < 4) [g, b] = [x, c];
  else if (hh < 5) [r, b] = [x, c];
  else [r, b] = [c, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

/** Force a colour into a LEGIBLE, vivid band for a dark UI (matches the app's neon accents): floor
 *  the lightness so a dark cover can't produce an unreadable near-black accent, and floor the
 *  saturation so a muted cover still pops — but leave a genuinely GREY cover grey (just lightened),
 *  never inventing a hue. Fixes "some album covers make the deck illegible". */
export function neonAccent(c: RGB): RGB {
  const [h, s, l] = rgbToHsl(c);
  const s2 = s > 0.08 ? Math.max(s, 0.5) : s; // only boost saturation if there's a real hue
  const l2 = Math.min(Math.max(l, 0.5), 0.68); // legible mid-bright band on a dark background
  return hslToRgb([h, s2, l2]);
}

/** neonAccent as hex→hex (returns the input unchanged if it isn't #rrggbb). Applied at the theming
 *  seam, so it fixes ALREADY-stored palettes too — the raw art colour stays in the dataset. */
export function neonHex(hex: string): string {
  const rgb = hexRgb(hex);
  return rgb ? rgbHex(neonAccent(rgb)) : hex;
}

const HEX = /^#[0-9a-fA-F]{6}$/;

/** Compact JSON for D1/transport. */
export function serializePalette(p: Palette): string {
  return JSON.stringify({ a: p.accent, l: p.low, m: p.mid, h: p.high });
}

/** Parse a stored palette; null on malformed input or a non-hex colour (caller then re-extracts). */
export function deserializePalette(s: string | null | undefined): Palette | null {
  if (!s) return null;
  try {
    const o = JSON.parse(s) as Record<string, unknown>;
    const a = o.a,
      l = o.l,
      m = o.m,
      h = o.h;
    if ([a, l, m, h].every((v) => typeof v === "string" && HEX.test(v as string)))
      return { accent: a as string, low: l as string, mid: m as string, high: h as string };
    return null;
  } catch {
    return null;
  }
}

/** Extract a palette from an image URL (must be same-origin / CORS-clean, else the canvas taints
 *  and this returns null). Downsamples to 48×48 — a median-cut over ~2 k pixels is sub-millisecond.
 *  Browser-only (uses <canvas>); returns null on any failure so a load never blocks on it. */
export async function extractPalette(url: string): Promise<Palette | null> {
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.crossOrigin = "anonymous";
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("img load failed"));
      el.src = url;
    });
    const S = 48;
    const cnv = document.createElement("canvas");
    cnv.width = S;
    cnv.height = S;
    const ctx = cnv.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, S, S);
    const data = ctx.getImageData(0, 0, S, S).data; // throws if tainted → caught below
    const px: RGB[] = [];
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 128) continue; // skip transparent
      px.push([data[i], data[i + 1], data[i + 2]]);
    }
    return paletteFrom(quantize(px, 6));
  } catch {
    return null;
  }
}
