// Hex/RGB colour primitives. The theme-derivation code in state/settings.ts re-declared
// these inline (twice); this is their shared home so future colour work has one place to
// reach for. Kept deliberately small — HSL conversion and perf-inlined canvas parsers
// stay local to their callers.

/** Round + clamp a number into a valid 0–255 colour channel. */
export const clampByte = (n: number): number => Math.max(0, Math.min(255, Math.round(n)));

/** A single channel value → two-digit lowercase hex (clamped). */
export const byteToHex = (n: number): string => clampByte(n).toString(16).padStart(2, "0");

/** "#rrggbb" / "#rgb" → [r, g, b]; falls back to the near-black base on bad input. */
export function hexToRgb(hex: string): [number, number, number] {
  let h = hex.replace("#", "").trim();
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h, 16);
  if (h.length !== 6 || Number.isNaN(n)) return [5, 5, 7];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
