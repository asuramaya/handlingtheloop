// Palette rolls for Settings ▸ Colour. Pure and seedable, so "does this generator actually
// produce usable themes" is a test rather than an opinion.
//
// ★ WHAT WAS WRONG BEFORE: every colour was its own independent uniform random hue. Nothing was
// spaced against anything, so a roll could hand you two decks the same colour, four stem lanes
// in one corner of the wheel, or three band hues you could not tell apart. Those are not rare
// edge cases: with 17 free hues, a collision somewhere is the NORMAL outcome. And "Mono" gave
// every accent its own random hue, which is the opposite of monochrome.
//
// The fix is that colours which must be told apart are placed AROUND the wheel rather than drawn
// from it, and colours that should agree are derived from one base hue.

export type RollHex = string;

const wrap = (h: number) => ((h % 360) + 360) % 360;
const randIn = (lo: number, hi: number) => lo + Math.random() * (hi - lo);
const randHue = () => Math.random() * 360;

export function hslToHex(h: number, s: number, l: number): string {
  const S = s / 100;
  const L = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = S * Math.min(L, 1 - L);
  const f = (n: number) => {
    const v = L - a * Math.max(-1, Math.min(Math.min(k(n) - 3, 9 - k(n)), 1));
    return Math.round(255 * v);
  };
  const hex = (v: number) => v.toString(16).padStart(2, "0");
  return `#${hex(f(0))}${hex(f(8))}${hex(f(4))}`;
}

/** ★ PLACE COLOURS BY HOW BRIGHT THEY LOOK, NOT BY HSL LIGHTNESS.
 *  These are not the same axis and the difference is large: a yellow at L=56 reads far brighter
 *  than a blue at L=64. Choosing lightness numbers and hoping the result is ordered produced
 *  exactly the failures the property tests caught — bands out of order, stem lanes that were
 *  supposed to differ by lightness sitting 6 apart instead of 12, deck accents that vanished
 *  against the background. Binary-searching L for a target LUMA makes the intent the input:
 *  "this one must look brighter than that one" becomes a number the generator hits every time.
 *  Rec.601, matching the ordering the waveform renderer reads depth from. */
function luma601(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return 0.299 * r + 0.587 * g + 0.114 * b;
}
export function hexAtLuma(hue: number, sat: number, target: number): string {
  let lo = 0;
  let hi = 100;
  let best = hslToHex(hue, sat, 50);
  for (let i = 0; i < 18; i++) {
    const mid = (lo + hi) / 2;
    best = hslToHex(hue, sat, mid);
    if (luma601(best) < target) lo = mid;
    else hi = mid;
  }
  return best;
}

/** `n` hues spread evenly around the wheel from `base`, each nudged by up to half a step so a
 *  roll never looks mechanically even, but never enough to close the gap to its neighbour. */
export function spreadHues(n: number, base: number, jitter = 0.34): number[] {
  const step = 360 / n;
  return Array.from({ length: n }, (_, i) => wrap(base + i * step + randIn(-step * jitter, step * jitter)));
}

/** Smallest angle between two hues, 0..180. */
export function hueGap(a: number, b: number): number {
  const d = Math.abs(wrap(a) - wrap(b));
  return d > 180 ? 360 - d : d;
}

/** Relative luminance, for the one relationship a theme must never get wrong. */
export function luminance(hex: string): number {
  const v = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
}

export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export interface Palette {
  accentA: string;
  accentB: string;
  bgColor: string;
  textColor: string;
  borderColor: string;
  selectorColor: string;
  loopColor: string;
  markerColor: string;
  shiftColor: string;
  stripColor: string;
  stemDrumsColor: string;
  stemBassColor: string;
  stemVocalsColor: string;
  stemOtherColor: string;
  freqLowColor: string;
  freqMidColor: string;
  freqHighColor: string;
}

/** A full colour theme built around one base hue.
 *
 *  Three sets have to survive being looked at side by side, so each is spread around the whole
 *  wheel rather than sampled from it: the two DECKS, the four STEM lanes, and the three BANDS.
 *  Everything else hangs off the base hue so the theme reads as one decision. */
export function randomTheme(): Palette {
  const base = randHue();

  // Decks sit opposite each other, give or take, so they can never be confused at a glance.
  const [deckA, deckB] = spreadHues(2, base, 0.22);
  // Stems get the wheel quartered. Rotated off the deck hues so a lane never wears a deck colour.
  const stems = spreadHues(4, base + 45, 0.28);
  // Bands get thirds. They are ALSO ordered by lightness, because the layered renderer stacks
  // them centre-outward and reads depth from luminance: a dark body, then mid, then a bright core.
  const bands = spreadHues(3, base + 20, 0.25);

  return {
    // Bright enough to hold up against a near-black ground whatever hue they landed on.
    accentA: hexAtLuma(deckA, randIn(80, 96), randIn(140, 175)),
    accentB: hexAtLuma(deckB, randIn(80, 96), randIn(140, 175)),
    // A near-black ground tinted toward the base hue, so even the background belongs to the theme.
    bgColor: hslToHex(base, randIn(18, 48), randIn(4, 8)),
    textColor: hslToHex(base, randIn(4, 16), randIn(90, 97)),
    borderColor: hslToHex(base, randIn(22, 50), randIn(20, 30)),
    selectorColor: hslToHex(base, randIn(0, 10), randIn(94, 100)),
    loopColor: hslToHex(wrap(base + 150), randIn(78, 94), randIn(56, 66)),
    markerColor: hslToHex(wrap(base + 210), randIn(70, 90), randIn(54, 64)),
    shiftColor: hslToHex(wrap(base + 90), randIn(78, 94), randIn(58, 68)),
    stripColor: hslToHex(wrap(base + 180), randIn(74, 92), randIn(54, 64)),
    stemDrumsColor: hslToHex(stems[0], randIn(76, 94), randIn(56, 66)),
    stemBassColor: hslToHex(stems[1], randIn(76, 94), randIn(56, 66)),
    stemVocalsColor: hslToHex(stems[2], randIn(76, 94), randIn(56, 66)),
    stemOtherColor: hslToHex(stems[3], randIn(76, 94), randIn(56, 66)),
    freqLowColor: hexAtLuma(bands[0], randIn(78, 95), randIn(62, 78)),
    freqMidColor: hexAtLuma(bands[1], randIn(78, 95), randIn(128, 148)),
    freqHighColor: hexAtLuma(bands[2], randIn(58, 82), randIn(198, 218)),
  };
}

/** Monochrome: a black-or-white ground and ONE hue, used in shades.
 *
 *  The old version rolled an independent random hue for all fourteen accents over a mono base,
 *  which is a random theme that happens to have a grey background. Monochrome means one hue, so
 *  the sets are separated here by LIGHTNESS instead of by hue — the only axis left. */
export function randomMono(): Palette {
  const darkBase = Math.random() < 0.5;
  const hue = randHue();
  const bg = darkBase ? "#000000" : "#ffffff";
  const text = darkBase ? "#ffffff" : "#000000";
  // Hue is spoken for, so every distinction here has to be carried by BRIGHTNESS — and that
  // means real luma, not HSL lightness: at a dark hue, four lanes 14 lightness apart came out
  // only 6 luma apart and stopped being tellable. Targets are spaced in luma directly.
  const lane = (i: number) => 62 + (i * 132) / 3; // 62 · 106 · 150 · 194
  const sat = () => randIn(70, 92);
  return {
    accentA: hexAtLuma(hue, sat(), darkBase ? 170 : 110),
    accentB: hexAtLuma(hue, sat(), darkBase ? 110 : 170),
    bgColor: bg,
    textColor: text,
    borderColor: darkBase ? "#2a2a2a" : "#cfcfcf",
    selectorColor: text,
    loopColor: hexAtLuma(hue, sat(), darkBase ? 190 : 95),
    markerColor: hexAtLuma(hue, randIn(20, 45), 140),
    shiftColor: hexAtLuma(hue, sat(), darkBase ? 215 : 80),
    stripColor: hexAtLuma(hue, sat(), 150),
    stemDrumsColor: hexAtLuma(hue, sat(), lane(0)),
    stemBassColor: hexAtLuma(hue, sat(), lane(1)),
    stemVocalsColor: hexAtLuma(hue, sat(), lane(2)),
    stemOtherColor: hexAtLuma(hue, sat(), lane(3)),
    freqLowColor: hexAtLuma(hue, sat(), 70),
    freqMidColor: hexAtLuma(hue, sat(), 135),
    freqHighColor: hexAtLuma(hue, randIn(30, 55), 205),
  };
}

/** Hue and saturation of a hex, so a picked colour can be re-shaded without losing its identity. */
export function hueSatOf(hex: string): { hue: number; sat: number } {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  if (mx === mn) return { hue: 0, sat: 0 };
  const d = mx - mn;
  const sat = (d / (1 - Math.abs(2 * l - 1))) * 100;
  let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60;
  return { hue: h < 0 ? h + 360 : h, sat: Math.min(100, sat) };
}

/** `n` shades of ONE colour, spread across a brightness range that reads on a dark lane.
 *
 *  For stem lanes that follow their deck: hue then says WHICH DECK you are looking at, and
 *  brightness says which lane — the same trade `randomMono` makes when hue is spoken for. Without
 *  the spread all four lanes would be the identical colour and the view would lose the one thing
 *  a stacked stem display is for. Placed by LUMA, not lightness, because at a dark hue equal
 *  lightness steps are not equal brightness steps. */
export function deckShades(hex: string, n = 4, lo = 70, hi = 205): string[] {
  const { hue, sat } = hueSatOf(hex);
  const s = Math.max(45, Math.min(96, sat));
  return Array.from({ length: n }, (_, i) => hexAtLuma(hue, s, lo + ((hi - lo) * i) / (n - 1)));
}
