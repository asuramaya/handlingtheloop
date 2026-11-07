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
  // "- Topic" (auto-generated music channels) and a glued "VEVO" ("RihannaVEVO") are both the
  // platform talking, not the artist.
  const stripped = s.replace(/\s*-\s*Topic$/i, "").replace(/(?<=\S)VEVO$/, "").trim();
  return stripped || s;
}

// ── TITLES AS A DJ READS THEM ─────────────────────────────────────────────────────────────────
//
// A YouTube title is a headline written for search: "Nicki Minaj - Moment 4 Life (Clean Version)
// (Official Music Video) ft. Drake". In a queue that repeats the artist column and buries the song
// under promo copy; and when the upload is a LABEL's ("Atlantic Records") or a lyrics page's, the
// real artist is ONLY in the title. displayTrack reads both fields together and returns what a
// person would write on a set list. Display only — the stored metadata, search and the automix's
// own matching (songCore / artistKey) are untouched.

/** Promo clutter: in brackets anywhere, or bare at the end. Version words (remix, mix, edit, live,
 *  acoustic, clean, explicit, remaster…) are deliberately NOT here — they tell two uploads apart. */
const CLUTTER =
  "(?:official\\s+)?(?:hd\\s+|4k\\s+)?(?:music\\s+video|lyric(?:s)?\\s+video|video\\s+clip|visuali[sz]er|video|audio|lyrics?|mv|m\\/v)(?:\\s+hd|\\s+4k)?|official|hd|hq|4k";
const BRACKETED = new RegExp(`\\s*[([](?:${CLUTTER})[)\\]]`, "gi");
const TRAILING = new RegExp(`\\s*[-–—|:]?\\s*(?:${CLUTTER})\\s*$`, "i");
const VERSION = /\b(?:remix|mix|edit|version|live|acoustic|remaster(?:ed)?|instrumental|extended|bootleg|vip|dub|rework|cover)\b/i;

function cleanTitle(t: string): string {
  let s = t.replace(BRACKETED, "");
  for (let i = 0; i < 2; i++) s = s.replace(TRAILING, "");
  s = s.replace(/\s{2,}/g, " ").trim();
  // A song name wrapped in quotes ("What's Up Danger") reads as a quotation, not a title.
  s = s.replace(/^["“'‘](.+?)["”'’](?=\s|$)/, "$1");
  return s.trim();
}

const norm = (x: string) =>
  x
    .toLowerCase()
    .replace(/\s*-\s*topic$/, "")
    .replace(/vevo$/, "")
    .replace(/[^a-z0-9]+/g, "");

/** Does channel `ch` name the act `who`? Either contains the other, once both are normalised. */
function sameAct(ch: string, who: string): boolean {
  const a = norm(ch);
  const b = norm(who);
  if (!a || !b) return false;
  if (a === b) return true;
  // Containment only for names long enough to mean something: "T.I." is "ti", and
  // "atlanticrecords" contains "ti" — the label would have passed for the artist.
  const short = a.length < b.length ? a : b;
  return short.length >= 4 && (a.includes(b) || b.includes(a));
}

export function displayTrack(title: string | null | undefined, artist: string | null | undefined): { title: string; artist: string } {
  const raw = (title ?? "").trim();
  const ch = displayArtist(artist);
  if (!raw) return { title: "", artist: ch };
  const m = raw.match(/^(.{1,60}?)\s+[-–—|]\s+(.+)$/);
  if (m) {
    const left = m[1].trim();
    const right = cleanTitle(m[2]);
    const leftClean = cleanTitle(left);
    if (!right) return { title: leftClean || raw, artist: ch }; // "Danza Kuduro - Official Video"
    if (sameAct(ch, left)) return { title: right, artist: ch }; // "Katy Perry - …" by Katy Perry
    if (sameAct(ch, right)) return { title: leftClean, artist: ch }; // "Bad Romance - Lady Gaga"
    // A song and its version ("Titanium - Extended Mix") is not an artist and a title.
    if (!VERSION.test(right) || /[([]/.test(right)) {
      // The channel is not the act (a label, a lyrics page, a fan upload): the act is on the left.
      if (!VERSION.test(right)) return { title: right, artist: left };
    }
  }
  const cleaned = cleanTitle(raw);
  return { title: cleaned || raw, artist: ch };
}
