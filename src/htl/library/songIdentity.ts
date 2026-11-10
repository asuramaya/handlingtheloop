// SONG IDENTITY — one module that answers "are these two uploads the same song?" and "which of
// them should we use?" for every surface that shows or picks tracks: the server's search, the
// automix radio, and the library lists (Community especially, a shared pool where the same record
// arrives as a Topic upload, an official video and three lyric-page re-uploads).
//
// Two levels, because the two callers want different strictness:
//
//   songKey      the SONG: core title + the real act. Version-blind on purpose — the automix uses it
//                for "never mix a track into itself", where a remix of what is playing is as bad a
//                next pick as a re-upload (sameSong in automix/selector.ts).
//   recordingKey the RECORDING: songKey + the version tags that make a different record (remix,
//                live, acoustic, sped up, "Taylor's Version"…). Clean/explicit/radio edit/remaster
//                and promo words ("Official Video", "Lyrics") are NOT tags: those are the same
//                recording, and choosing among them is what the ranking is for. Plus a duration
//                check (±3 s when both are known), so two different songs that share a name and an
//                act ("Intro") never merge. This is what the lists collapse on.
//
// THE RANKING (compareVersions), operator 2026-11-10 — "the plague of censored songs when what I'm
// really after is the raw uncensored version":
//   1. explicit > unknown > censored. Explicit = YouTube Music's explicit badge (search carries it
//      through as `explicit: true`) or the title says explicit/uncensored/dirty; censored = the title
//      says clean/censored/edited/radio edit.
//   2. Artist - Topic (the album audio — usually the explicit album cut) > official audio > a plain
//      upload on the act's own channel > music video (videos are often the edited cut) > lyric /
//      fan / label uploads.
//   3. analysed (BPM and key known) > not — a version we can already beatmatch.
//   4. views.
//
// Pure and dependency-light (types + util/format only): the worker imports it for search.
import type { TrackMeta } from "./types";
import { displayTrack } from "../../util/format";

// ── song core (moved here from automix/mixability.ts, re-exported there) ─────────────────────────

/** Cut a title at the first remix/version/feature/mashup marker and reduce it to bare words. */
function coreOf(s: string): string {
  return s
    .replace(/\b(feat\.?|ft\.?|featuring|vs\.?|remix|mix|cover|version|mashup|edit|bootleg|live|acoustic|remaster(?:ed)?|official|lyrics?|audio|video)\b.*$/i, " ")
    .replace(/\s+x\s+.*$/i, " ") // "Song x Other" mashup → keep the first song
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** A normalized "song identity" from a title — drops version/remix/feature/mashup
 *  markers so different uploads of the SAME song collapse to one key. Used to stop the
 *  queue from suggesting "Danza Kuduro → Danza Kuduro (Original Mix) → Danza Kuduro x …".
 *  This is song-level DEDUP (matching the song name in the title), not slop filtering. */
export function songCore(title: string): string {
  let s = fold(title);
  s = s.replace(/\([^)]*\)/g, " ").replace(/\[[^\]]*\]/g, " "); // drop (…) and […]

  // ★ SEE THROUGH A LEADING "ARTIST - " PREFIX. Without this the dedup failed on the single most
  // embarrassing case there is: the seed track coming straight back. YouTube is wildly
  // inconsistent about the prefix — a "- Topic" channel uploads "Teardrop (Remastered 2019)" while
  // every other upload of the same recording is "Massive Attack - Teardrop (Live in Berlin)".
  // Different keys, so the radio followed Teardrop with Teardrop, then with a Teardrop cover.
  //
  // But "X - Y" is genuinely ambiguous: "Massive Attack - Teardrop" is artist-then-song, while
  // "Danza Kuduro - Official Video" is song-then-junk. Guessing wrong either way loses the song
  // name. So take the half that SURVIVES the marker cut: in the first case the tail is a real
  // title ("teardrop"), in the second it is pure junk and reduces to nothing, which is the signal
  // that the song name was on the left all along.
  const dash = s.match(/^\s*[^-–—]{1,40}\s[-–—]\s(.+)$/);
  if (dash) {
    const tail = coreOf(dash[1]);
    if (tail.length >= 3) return tail;
  }
  return coreOf(s);
}

// ── artist ───────────────────────────────────────────────────────────────────────────────────

/** Normalised artist identity. YouTube's "artist" is a channel name, so the same act arrives as
 *  "Burial", "Burial - Topic", "BurialVEVO" and "Burial Official" — all one artist for cooldown
 *  purposes, and treating them as four is how the same act got played four times in a row.
 *  (Moved here from automix/selector.ts, re-exported there.) */
export function artistKey(artist: string | null | undefined): string {
  let s = fold(artist ?? "");
  s = s.replace(/\s*-\s*topic\s*$/, " ");
  s = s.replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  // Channel decorations, stripped from the END and NOT required to be their own word — YouTube
  // writes both "Burial Official" and "BurialVEVO", and a \b-anchored match silently misses the
  // second, which is exactly the case that lets one act through the cooldown twice. Looped,
  // because they stack ("Artist Official Music").
  for (let i = 0; i < 3; i++) {
    const next = s.replace(/\s*(vevo|official|officiel|music|records|recordings|channel|tv|hd)\s*$/, "").trim();
    if (next === s) break;
    s = next;
  }
  return s;
}

/** The ACT behind an upload, as one spaceless key. The channel is not always the act: a label or a
 *  lyrics page puts the artist in the title ("Imogen Heap - Headlock (Lyrics)" by "7clouds"), which
 *  displayTrack already reads. YouTube Music lists several artists comma-separated; the first is the
 *  act. Spaces go so "Imogen Heap - Topic" and "ImogenHeapVEVO" agree. */
function actKey(dtArtist: string): string {
  const first = (dtArtist || "").split(",")[0].replace(/\s+(?:feat\.?|ft\.?|featuring)\s+.*$/i, "");
  return artistKey(first).replace(/\s+/g, "");
}

// ── versions ─────────────────────────────────────────────────────────────────────────────────

/** Words that make a DIFFERENT RECORDING when they qualify a title. */
const VERSION_WORD =
  /\b(remix(?:ed)?|rmx|mix|live|acoustic|unplugged|instrumental|karaoke|cover|extended|club|dub|vip|rework|bootleg|flip|edit|sped\s*up|speed\s*up|slowed|reverb|nightcore|8d|demo|a\s*cappella|acapella|piano|orchestral|version|session|stripped|reprise|mashup)\b/;

/** Same-recording qualifiers, removed before looking for a version word: a clean or explicit cut,
 *  a radio edit, a remaster, the album/original/single cut, promo words. */
const SAME_RECORDING = [
  /\b(?:clean|explicit|censored|uncensored|dirty|edited|album|original|single|radio|lp|main)\s+(?:version|edit|mix|cut)\b/g,
  /\b(?:\d{4}\s+)?remaster(?:ed)?(?:\s+(?:version|\d{4}))?\b/g,
  /\b(?:clean|explicit|censored|uncensored|dirty|edited)\b/g,
  /\b(?:official|lyrics?|audio|video|music|visuali[sz]er|hd|hq|4k|mv|m\/v)\b/g,
  /\b(?:feat\.?|ft\.?|featuring)\s+.*$/g,
];

function versionOf(segment: string): string {
  let s = fold(segment);
  // A radio edit OF something else is that something else: "Alive Radio Edit 2007" is the live
  // album's edit, not the studio cut's (seen in the production Community pool, 2026-11-10).
  const radio = RADIO_EDIT.test(s);
  for (const re of SAME_RECORDING) s = s.replace(re, " ");
  s = s.replace(/[^a-z0-9\s]/g, " ").replace(/\b(?:19|20)\d\d\b/g, " ").replace(/\s+/g, " ").trim();
  return VERSION_WORD.test(s) || (radio && s) ? s : "";
}

/** Lower case, accents off: "Björk" and "Bjork", "Te Boté" and "Te Bote" are one name. */
function fold(s: string): string {
  return (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** The version tags of a title, sorted and joined: "" for the original recording. */
export function versionTags(title: string): string {
  const tags = new Set<string>();
  const t = title || "";
  for (const m of t.matchAll(/\(([^)]*)\)|\[([^\]]*)\]/g)) {
    const v = versionOf(m[1] ?? m[2] ?? "");
    if (v) tags.add(v);
  }
  const bare = t.replace(/\([^)]*\)|\[[^\]]*\]/g, " ");
  // "Song - Extended Mix" (a dash tail), or a bare qualifier ("Teardrop Live at Glastonbury").
  const dash = bare.match(/\s[-–—]\s(.+)$/);
  if (dash) {
    const v = versionOf(dash[1]);
    if (v) tags.add(v);
  }
  const head = (dash ? bare.slice(0, dash.index) : bare).toLowerCase();
  const word = head.replace(/\b(?:feat\.?|ft\.?|featuring)\s+.*$/, " ").match(VERSION_WORD);
  if (word && word.index != null) {
    const v = versionOf(head.slice(word.index));
    if (v) tags.add(v);
  }
  if (/\s+x\s+\S/i.test(head.replace(/\b(?:feat\.?|ft\.?)\s+.*$/, ""))) tags.add("mashup");
  return Array.from(tags).sort().join("+");
}

// ── keys ─────────────────────────────────────────────────────────────────────────────────────

type Named = Pick<TrackMeta, "title" | "artist">;

/** The song (version-blind): core title + act, or "" when either half is unknown. */
export function songKey(t: Named): string {
  const dt = displayTrack(t.title, t.artist);
  const core = songCore(dt.title) || songCore(t.title);
  const act = actKey(dt.artist);
  return core && act ? `${core}|${act}` : "";
}

/** The recording: songKey + version tags, or "" when the song is unknown. */
export function recordingKey(t: Named): string {
  // Memoised by title+artist: a library list re-groups on every render it gets a new array, and a
  // Community pool is thousands of rows of regex work that never changes for a given upload.
  const memo = `${t.title ?? ""}\u0000${t.artist ?? ""}`;
  const hit = KEY_MEMO.get(memo);
  if (hit !== undefined) return hit;
  const key = computeRecordingKey(t);
  if (KEY_MEMO.size >= KEY_MEMO_MAX) KEY_MEMO.clear();
  KEY_MEMO.set(memo, key);
  return key;
}
const KEY_MEMO = new Map<string, string>();
const KEY_MEMO_MAX = 20000;

function computeRecordingKey(t: Named): string {
  const k = songKey(t);
  if (!k) return "";
  // From the DISPLAY title: displayTrack keeps every version word but has already taken a leading
  // "Artist - " off, so an act whose name is a version word (the band Live) is not read as one.
  return `${k}#${versionTags(displayTrack(t.title, t.artist).title)}`;
}

const DURATION_TOLERANCE = 3; // seconds

/** Do two lengths agree? Unknown (0/null) on either side is not evidence against. A radio edit is
 *  shorter than the album cut by design, so it is excused when either title says so. */
function durationsAgree(a: Pick<TrackMeta, "duration" | "title">, b: Pick<TrackMeta, "duration" | "title">): boolean {
  const da = a.duration || 0;
  const db = b.duration || 0;
  if (da <= 0 || db <= 0) return true;
  if (Math.abs(da - db) <= DURATION_TOLERANCE) return true;
  return RADIO_EDIT.test(a.title || "") || RADIO_EDIT.test(b.title || "");
}

/** Same recording, possibly another upload of it: what the lists collapse. */
export function sameRecording(a: TrackMeta | null | undefined, b: TrackMeta | null | undefined): boolean {
  if (!a || !b) return false;
  if (a.videoId && a.videoId === b.videoId) return true;
  const ka = recordingKey(a);
  return !!ka && ka === recordingKey(b) && durationsAgree(a, b);
}

// ── cleanliness and upload kind ──────────────────────────────────────────────────────────────

export type Cleanliness = "explicit" | "unknown" | "censored";

const RADIO_EDIT = /\bradio\s+(?:edit|version)\b/i;
// "clean" / "dirty" / "edited" only as a QUALIFIER (in brackets, after a dash, or "clean version"):
// "Clean" (Taylor Swift) and "Squeaky Clean" are song names.
const CENSORED =
  /\bcensored\b|\bradio\s+(?:edit|version)\b|\b(?:clean|edited)\s+(?:version|edit|mix|cut)\b|[([][^)\]]*\b(?:clean|edited|censored)\b[^)\]]*[)\]]|\s[-–—]\s*(?:clean|edited)\s*$|\bkidz\s+bop\b/i;
const EXPLICIT =
  /\buncensored\b|\bexplicit\b|\bdirty\s+(?:version|mix|edit)\b|[([][^)\]]*\bdirty\b[^)\]]*[)\]]|\bnsfw\b/i;

/** Is this the raw cut, the censored one, or can we not tell? The YouTube Music explicit badge
 *  (carried as `explicit: true`) is the only hard signal; the rest is the title's own word. */
export function cleanliness(t: Pick<TrackMeta, "title"> & { explicit?: boolean | null }): Cleanliness {
  if (t.explicit === true) return "explicit";
  const title = t.title || "";
  // "Uncensored" contains "censored": test explicit first.
  if (EXPLICIT.test(title)) return "explicit";
  if (CENSORED.test(title)) return "censored";
  return "unknown";
}

export type UploadKind = "topic" | "audio" | "artist" | "video" | "other";

/** What kind of upload: the Topic album audio, an official audio, a plain upload on the act's own
 *  channel, a music video, or a lyric/fan/label upload. */
export function uploadKind(t: Named): UploadKind {
  const artist = t.artist || "";
  if (/\s-\s*topic\s*$/i.test(artist)) return "topic";
  const title = (t.title || "").toLowerCase();
  if (/\blyrics?\b|\bletra\b|\bsub(?:titulado|s)?\b|\bnightcore\b|\b8d\b/.test(title)) return "other";
  if (/\bofficial\s+audio\b|[([]\s*audio\s*[)\]]|\bvisuali[sz]er\b|\bofficial\s+(?:art\s+)?track\b/.test(title)) return "audio";
  if (/\bmusic\s+video\b|\bofficial\s+video\b|[([]\s*(?:official\s+)?(?:hd\s+)?video\s*[)\]]|\bm\/?v\b|\bvideo\s+clip\b/.test(title)) return "video";
  // A plain title on the act's own channel (the Music shelf's song rows look like this too).
  const dt = displayTrack(t.title, artist);
  if (actKey(dt.artist) && actKey(dt.artist) === actKey(artist.replace(/vevo$/i, ""))) return "artist";
  return "other";
}

/** A few words telling one upload from its siblings in a narrow menu, where the titles (which all
 *  start with the same song name) truncate to the same thing: "Album audio", "Video · clean". */
export function versionLabel(t: Named & { explicit?: boolean | null }): string {
  const kind = uploadKind(t);
  const lyric = /\blyrics?\b|\bletra\b/i.test(t.title || "");
  const name =
    kind === "topic" ? "Album audio" : kind === "audio" ? "Official audio" : kind === "artist" ? "Artist upload" : kind === "video" ? "Video" : lyric ? "Lyric upload" : "Upload";
  const c = cleanliness(t);
  return c === "unknown" ? name : `${name} · ${c === "explicit" ? "explicit" : "clean"}`;
}

const CLEAN_RANK: Record<Cleanliness, number> = { explicit: 2, unknown: 1, censored: 0 };
const KIND_RANK: Record<UploadKind, number> = { topic: 4, audio: 3, artist: 2, video: 1, other: 0 };

type Rankable = TrackMeta & { explicit?: boolean | null };

/** Order two versions of one song, best first (negative = `a` is better). See the header. */
export function compareVersions(a: Rankable, b: Rankable): number {
  const c = CLEAN_RANK[cleanliness(b)] - CLEAN_RANK[cleanliness(a)];
  if (c) return c;
  const k = KIND_RANK[uploadKind(b)] - KIND_RANK[uploadKind(a)];
  if (k) return k;
  const an = (t: TrackMeta) => (t.bpm != null && !!t.key ? 1 : 0);
  const n = an(b) - an(a);
  if (n) return n;
  return (b.views ?? 0) - (a.views ?? 0);
}

// ── grouping ─────────────────────────────────────────────────────────────────────────────────

export interface VersionGroup<T> {
  /** The version to show / use. */
  best: T;
  /** Every other upload of the same recording, best first. */
  others: T[];
}

/** Group a list into recordings, in the order each recording FIRST appears. The best version of
 *  each leads its group, unless `pin` names a member (the version loaded on a deck must stay the
 *  visible row, or its deck highlight has nothing to land on). A track with no usable identity is a
 *  group of one. Nothing is dropped: every input is either a `best` or in some `others`. */
export function groupVersions<T extends Rankable>(list: readonly T[], opts: { pin?: (t: T) => boolean } = {}): VersionGroup<T>[] {
  const groups: T[][] = [];
  const byKey = new Map<string, T[][]>();
  for (const t of list) {
    const k = recordingKey(t);
    if (!k) {
      groups.push([t]);
      continue;
    }
    const clusters = byKey.get(k) ?? [];
    const home = clusters.find((g) => g.every((m) => durationsAgree(m, t)));
    if (home) home.push(t);
    else {
      const g = [t];
      clusters.push(g);
      byKey.set(k, clusters);
      groups.push(g);
    }
  }
  return groups.map((g) => {
    if (g.length === 1) return { best: g[0], others: [] };
    const ranked = g.slice().sort(compareVersions);
    const pinned = opts.pin ? ranked.find((t) => opts.pin!(t)) : undefined;
    const best = pinned ?? ranked[0];
    return { best, others: ranked.filter((t) => t !== best) };
  });
}

/** The list with each recording reduced to its best version (search results, a radio pool). */
export function collapseVersions<T extends Rankable>(list: readonly T[], opts: { pin?: (t: T) => boolean } = {}): T[] {
  return groupVersions(list, opts).map((g) => g.best);
}
