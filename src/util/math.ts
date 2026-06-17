// Small numeric helpers shared across the app. These were copy-pasted into a dozen
// files (Deck, the FX devices, the auto-mixer, every canvas panel); consolidated here
// so there is one definition to reason about.

/** Clamp `v` into the inclusive range [lo, hi]. */
export const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/** Clamp `v` into [0, 1] — the common unipolar case. */
export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Linear interpolation from `a` to `b` by `t` (t is NOT clamped). */
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
