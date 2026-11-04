export function fmtTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function fmtViews(n: number | null | undefined): string {
  if (n == null) return "";
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return String(n);
}

// Compact unit formatters for control labels (EQ/FX panels, value cells). Previously
// re-declared inline in DelayPanel/EqCurve/ReverbPanel — same logic each time.

/** Frequency: "440", "1.2k", "12k" (drops the decimal at ≥10 kHz). */
export const fmtHz = (hz: number): string =>
  hz >= 1000 ? `${(hz / 1000).toFixed(hz >= 10000 ? 0 : 1)}k` : `${Math.round(hz)}`;

/** Gain in dB with an explicit leading sign: "+3.0", "-6.0", "0.0". */
export const fmtDb = (db: number): string => `${db > 0 ? "+" : ""}${db.toFixed(1)}`;

/** Fraction → integer percent string: 0.5 → "50". */
export const fmtPct = (v: number): string => `${Math.round(v * 100)}`;

/** Seconds → "12.34s" at ≥1s, else milliseconds: 0.375 → "375". */
export const fmtMs = (s: number): string => (s >= 1 ? `${s.toFixed(2)}s` : `${Math.round(s * 1000)}`);

/**
 * An artist name as it should be READ. YouTube's "artist" is a channel name, and its auto-generated
 * music channels are all "<Artist> - Topic": a suffix that is noise to a person, and that cost the
 * Library's Artist column its width ("Britney Spears - To…" while Title had room to spare).
 * Display only: the stored value is untouched (automix's artistKey does its own normalising), and
 * a name that is nothing BUT "Topic" is left alone rather than blanked.
 */
export function displayArtist(artist: string | null | undefined): string {
  const s = (artist ?? "").trim();
  const stripped = s.replace(/\s*-\s*Topic$/i, "").trim();
  return stripped || s;
}
