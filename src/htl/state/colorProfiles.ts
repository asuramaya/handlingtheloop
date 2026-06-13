// Named COLOUR PROFILES: a saved, shareable snapshot of the theme's colour settings.
// Mirrors the MIDI maps (src/htl/midi/maps.ts): stored in Settings → account-synced
// for free (the @htl Settings blob syncs to /api/me/settings), and exported as JSON to
// share a look with other users. No Settings import here (keeps this dep-free / no cycle
// — settings.ts imports the TYPE from this file).

export type ColorValue = string | number | boolean;
export type ColorSnapshot = Record<string, ColorValue>;

export interface ColorProfile {
  id: string;
  name: string;
  colors: ColorSnapshot; // the captured colour-setting values (see COLOR_PROFILE_KEYS)
  updatedAt: number;
}

// The Settings keys a colour profile captures — a complete "look": deck accents, the
// theme base (bg/text/border), the waveform colours (selector/loop/marker/accents/strip),
// the per-stem lane colours, the frequency-band hues, and the band display options.
export const COLOR_PROFILE_KEYS = [
  "accentA",
  "accentB",
  "bgColor",
  "textColor",
  "borderColor",
  "selectorColor",
  "loopColor",
  "markerColor",
  "shiftColor",
  "stripColor",
  "stemDrumsColor",
  "stemBassColor",
  "stemVocalsColor",
  "stemOtherColor",
  "freqLowColor",
  "freqMidColor",
  "freqHighColor",
  "freqColors",
  "freqVividness",
  "glow",
] as const;

const EXPORT_KIND = "htl-color-profile";
const EXPORT_VERSION = 1;

function uid(): string {
  try {
    const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
    if (c?.randomUUID) return c.randomUUID();
  } catch {
    /* fall through */
  }
  return `c_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
}

// Pull the colour-profile keys out of a settings-like object into a flat snapshot.
export function snapshotColors(s: Record<string, ColorValue>): ColorSnapshot {
  const out: ColorSnapshot = {};
  for (const k of COLOR_PROFILE_KEYS) if (k in s && s[k] !== undefined) out[k] = s[k];
  return out;
}

export function createColorProfile(name: string, colors: ColorSnapshot): ColorProfile {
  return { id: uid(), name: name.trim() || "Untitled theme", colors: { ...colors }, updatedAt: Date.now() };
}

export function duplicateColorProfile(p: ColorProfile): ColorProfile {
  return { ...p, id: uid(), name: `${p.name} copy`, colors: { ...p.colors }, updatedAt: Date.now() };
}

// Pretty JSON for clipboard / file — what gets shared.
export function exportColorProfile(p: ColorProfile): string {
  return JSON.stringify({ kind: EXPORT_KIND, version: EXPORT_VERSION, profile: p }, null, 2);
}

// Parse a shared profile (pasted text / file). Returns a FRESH-id copy so importing never
// collides with an existing one. Only known colour keys are kept (drops anything foreign).
export function parseColorProfile(text: string): ColorProfile | null {
  try {
    const o = JSON.parse(text) as { kind?: string; profile?: Partial<ColorProfile> };
    const p = o?.kind === EXPORT_KIND && o.profile ? o.profile : (o as unknown as Partial<ColorProfile>);
    if (!p || typeof p.colors !== "object" || p.colors == null) return null;
    const allowed = new Set<string>(COLOR_PROFILE_KEYS);
    const colors: ColorSnapshot = {};
    for (const [k, v] of Object.entries(p.colors)) {
      if (allowed.has(k) && (typeof v === "string" || typeof v === "number" || typeof v === "boolean")) colors[k] = v;
    }
    if (Object.keys(colors).length === 0) return null;
    return {
      id: uid(),
      name: typeof p.name === "string" && p.name.trim() ? p.name : "Imported theme",
      colors,
      updatedAt: Date.now(),
    };
  } catch {
    return null;
  }
}
