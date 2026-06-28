// Free/public audio-feature lookup by ISRC, so the auto-mixer can get key/BPM for a
// track without decoding it. Two hops, both keyless public APIs:
//   ISRC → MusicBrainz recording MBID → AcousticBrainz precomputed features.
// AcousticBrainz's corpus is frozen (~2022) and coverage is patchy, so this is a
// best-effort first attempt; callers fall back to background decode-analysis.

const MB = "https://musicbrainz.org/ws/2";
const AB = "https://acousticbrainz.org/api/v1";
// MusicBrainz requires a descriptive User-Agent (and rate-limits ~1 req/s).
const UA = "HandlingTheLoop/1.0 ( https://handlingtheloop.com )";
const TIMEOUT_MS = 8000;

export interface Features {
  bpm: number | null;
  key: string | null; // Camelot code, e.g. "8A"
}

// Pitch class (0=C … 11=B) for a note name, accepting sharps and flats.
const PC: Record<string, number> = {
  C: 0, "B#": 0,
  "C#": 1, DB: 1,
  D: 2,
  "D#": 3, EB: 3,
  E: 4, FB: 4,
  F: 5, "E#": 5,
  "F#": 6, GB: 6,
  G: 7,
  "G#": 8, AB: 8,
  A: 9,
  "A#": 10, BB: 10,
  B: 11, CB: 11,
};
// Camelot codes indexed by pitch class (0=C … 11=B).
const CAMELOT_MAJOR = ["8B", "3B", "10B", "5B", "12B", "7B", "2B", "9B", "4B", "11B", "6B", "1B"];
const CAMELOT_MINOR = ["5A", "12A", "7A", "2A", "9A", "4A", "11A", "6A", "1A", "8A", "3A", "10A"];

export function toCamelot(keyKey: unknown, keyScale: unknown): string | null {
  if (typeof keyKey !== "string") return null;
  const pc = PC[keyKey.trim().toUpperCase()];
  if (pc == null) return null;
  const minor = typeof keyScale === "string" && keyScale.toLowerCase().startsWith("min");
  return minor ? CAMELOT_MINOR[pc] : CAMELOT_MAJOR[pc];
}

async function jget(url: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(url, {
      headers: { "user-agent": UA, accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const ISRC_RE = /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/;

async function mbidForIsrc(isrc: string): Promise<string | null> {
  const j = await jget(`${MB}/isrc/${encodeURIComponent(isrc)}?fmt=json&inc=recordings`);
  const recs = j?.recordings as { id?: string }[] | undefined;
  return recs?.[0]?.id ?? null;
}

/** The ISRC for a MusicBrainz recording id — the global track id from an AcoustID
 *  fingerprint match. null if the recording has no ISRC registered. */
export async function isrcForMbid(mbid: string): Promise<string | null> {
  if (!/^[0-9a-f-]{36}$/i.test(mbid)) return null;
  const j = await jget(`${MB}/recording/${encodeURIComponent(mbid)}?fmt=json&inc=isrcs`);
  const isrcs = j?.isrcs as string[] | undefined;
  return isrcs?.[0] ?? null;
}

/** Best-effort key/BPM for an ISRC via MusicBrainz → AcousticBrainz. null if unknown. */
export async function featuresByIsrc(isrc: string): Promise<Features | null> {
  const code = isrc.trim().toUpperCase();
  if (!ISRC_RE.test(code)) return null;
  const mbid = await mbidForIsrc(code);
  if (!mbid) return null;
  const ll = await jget(`${AB}/${mbid}/low-level`);
  if (!ll) return null;
  const rhythm = ll.rhythm as { bpm?: number } | undefined;
  const tonal = ll.tonal as { key_key?: string; key_scale?: string } | undefined;
  const bpm = typeof rhythm?.bpm === "number" ? Math.round(rhythm.bpm) : null;
  const key = toCamelot(tonal?.key_key, tonal?.key_scale);
  if (bpm == null && key == null) return null;
  return { bpm, key };
}
