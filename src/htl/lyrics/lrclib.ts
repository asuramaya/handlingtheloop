// LRCLIB — the WORDS. (The times come from the vocal stem; see lrcAlign.ts.)
//
// ★ WHY THIS EXISTS AT ALL. We spent two sessions asking Whisper to read singing and it kept
// inventing words — not because it was too small (large-v3-turbo failed too) but because a
// GENERATIVE model samples the next token conditioned on audio it finds ambiguous, and sung vowels
// are maximally ambiguous. Making things up is IN ITS OUTPUT SPACE. Meanwhile the words to nearly
// every song are already written down. Inferring a fact from signal when the fact is PUBLISHED is a
// choice, and it was the wrong one.
//
// Measured on the operator's real library (36 tracks the app had already identified): 92% came back
// LINE-SYNCED, 97% had words at all — including Japanese, Korean, Spanish and hyperpop, which is
// precisely the material Whisper hallucinated through. The multilingual problem doesn't get solved
// here, it EVAPORATES: there is no acoustic model, so there is nothing to be monolingual about.
//
// LRCLIB is free, needs no API key, and serves `access-control-allow-origin: *` — so the BROWSER
// calls it directly. No worker route, no proxy, no secret.
import type { LyricsLine } from "./types";

/** One line of an LRC file: when it starts, and what is sung. */
export interface LrcLine {
  t: number; // seconds
  text: string;
}

export interface LrcResult {
  /** Line-timed lyrics — the good case (92% of a real library). */
  synced: LrcLine[] | null;
  /** Un-timed lines. Words are still ground truth; the timing is entirely ours to find. */
  plain: string[] | null;
  /** LRCLIB knows this recording has no vocals — a free, CORRECT "no lyrics", where Whisper used to
   *  hallucinate a verse over a techno track. This is what replaces looksDegenerate(). */
  instrumental: boolean;
}

interface LrcLibRow {
  syncedLyrics?: string | null;
  plainLyrics?: string | null;
  instrumental?: boolean;
  duration?: number;
}

// `[mm:ss.xx] text` — the whole format. Some files use a 2-digit centisecond, some 3-digit ms; some
// stack several stamps on one line ("[00:12.00][01:04.00] chorus"). Handle all of it.
const STAMP = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;

/** Parse an LRC body into timed lines, sorted, with the metadata/blank lines dropped. */
export function parseLrc(body: string): LrcLine[] {
  const out: LrcLine[] = [];
  for (const raw of body.split(/\r?\n/)) {
    STAMP.lastIndex = 0;
    const stamps: number[] = [];
    let m: RegExpExecArray | null;
    let end = 0;
    while ((m = STAMP.exec(raw))) {
      // Only stamps at the HEAD of the line are timestamps; one mid-line is a lyric, not a cue.
      if (m.index !== end) break;
      end = STAMP.lastIndex;
      const min = Number(m[1]);
      const sec = Number(m[2]);
      // ".5" is 5 tenths, ".05" is 5 hundredths, ".005" is 5 thousandths — scale by digit count.
      const frac = m[3] ? Number(m[3]) / 10 ** m[3].length : 0;
      stamps.push(min * 60 + sec + frac);
    }
    if (!stamps.length) continue; // an [ar:]/[ti:]/[by:] metadata line, or junk
    const text = raw.slice(end).trim();
    if (!text) continue; // a timed BLANK line = an instrumental gap. Not a lyric; drop it.
    for (const t of stamps) out.push({ t, text });
  }
  return out.sort((a, b) => a.t - b.t);
}

/** Strip the version noise LRCLIB doesn't index on ("(radio edit)", "- 2011 Remaster", "feat. X"). */
export function cleanTitle(title: string): string {
  return title
    .replace(/\s*[([][^)\]]*(edit|mix|version|remaster|remix|feat\.?|ft\.?|radio|live|bonus)[^)\]]*[)\]]/gi, "")
    .replace(/\s*[-–—]\s*[^-–—]*(remaster|version|edit|mix)[^-–—]*$/gi, "")
    .trim();
}

/** The first credited artist. LRCLIB indexes on one name; our identity layer joins them with commas
 *  ("Afrojack, Eva Simons"), and a comma-joined string matches nothing. */
export function primaryArtist(artist: string): string {
  return artist.split(/\s*[,&]\s*|\s+(?:feat\.?|ft\.?|with)\s+/i)[0].trim();
}

function readRow(r: LrcLibRow | null | undefined): LrcResult | null {
  if (!r) return null;
  if (r.instrumental) return { synced: null, plain: null, instrumental: true };
  const synced = r.syncedLyrics ? parseLrc(r.syncedLyrics) : [];
  const plain = (r.plainLyrics ?? "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!synced.length && !plain.length) return null;
  return { synced: synced.length ? synced : null, plain: plain.length ? plain : null, instrumental: false };
}

const BASE = "https://lrclib.net/api";
// LRCLIB asks clients to identify themselves. Be a good citizen of a free service.
const UA = "handlingtheloop (https://handlingtheloop.com)";

// Each REQUEST gets its own budget. LRCLIB is a free service and it is genuinely slow — a duration-
// matched /get takes about 4 s and a fuzzy /search about 9 s (measured). Those are not hangs, they
// are the service working, and a budget that cannot tell the difference will abort a lookup that was
// about to succeed and report it as "no match".
const REQ_TIMEOUT_MS = 15000;
// ★ A 404 IS A MISS; EVERYTHING ELSE IS A FAILURE, AND THE TWO MUST NOT BLUR. This used to return
// null for any non-ok status, so a 429 (we lean on a free service, and it is measurably slow — a
// /get takes 7-10s live) read exactly like "LRCLIB has never seen this recording". A timeout
// reported as a miss sends the caller to the WRONG fallback: captions for a track whose lyrics
// exist. Misses return null; failures throw, and fetchLrcLib re-throws them at the end unless some
// other request genuinely answered.
async function get(url: string, signal?: AbortSignal): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQ_TIMEOUT_MS);
  const onAbort = () => ctrl.abort();
  signal?.addEventListener("abort", onAbort);
  try {
    const r = await fetch(url, { headers: { "Lrclib-Client": UA }, signal: ctrl.signal });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`lrclib ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Find a track's lyrics. Tries the exact (artist, title, duration) match first — LRCLIB's `/get`
 * checks duration to within a couple of seconds, which is what stops us pulling a cover or a live
 * take — then falls back to a fuzzier search on a cleaned title and the primary artist.
 *
 * Everything is best-effort: any failure is a miss, and the caller falls through to YouTube captions.
 */
export async function fetchLrcLib(
  q: { artist: string; title: string; album?: string | null; duration?: number },
  signal?: AbortSignal,
): Promise<LrcResult | null> {
  const artist = q.artist.trim();
  const title = q.title.trim();
  if (!artist || !title) return null;
  // Any request that FAILED (threw) rather than MISSED (404). If nothing hits and at least one
  // request failed, we don't know the track is absent — so the whole lookup throws, and the
  // caller's `bounded` records it as lookupFailed instead of a miss.
  let failed = false;
  const tryGet = async (url: string): Promise<unknown> => {
    try {
      return await get(url, signal);
    } catch {
      failed = true;
      return null;
    }
  };

  // 1) Exact — with duration, so a 3-minute radio edit can't match a 7-minute extended mix.
  if (q.duration && q.duration > 0) {
    const p = new URLSearchParams({
      artist_name: artist,
      track_name: title,
      duration: String(Math.round(q.duration)),
    });
    if (q.album) p.set("album_name", q.album);
    const hit = readRow((await tryGet(`${BASE}/get?${p}`)) as LrcLibRow | null);
    if (hit) return hit;
  }

  // 2) Fuzzier: primary artist + a title with the version noise stripped. This is what rescues
  //    "Afrojack, Eva Simons — Take Over Control (radio edit)", which is a real row in our library.
  for (const [a, t] of [
    [artist, title],
    [primaryArtist(artist), cleanTitle(title)],
  ]) {
    if (!a || !t) continue;
    const p = new URLSearchParams({ artist_name: a, track_name: t });
    const rows = (await tryGet(`${BASE}/search?${p}`)) as LrcLibRow[] | null;
    if (!Array.isArray(rows) || !rows.length) continue;
    // Prefer a row whose duration is close to ours AND that carries real line timings.
    const scored = rows
      .map((r) => ({
        r,
        dt: q.duration && r.duration ? Math.abs(r.duration - q.duration) : 999,
        sync: r.syncedLyrics ? 0 : 1,
      }))
      .sort((x, y) => x.sync - y.sync || x.dt - y.dt);
    const hit = readRow(scored[0].r);
    if (hit) return hit;
  }
  // No hit anywhere, and at least one request DIED rather than answered: this is not a miss.
  if (failed) throw new Error("lrclib lookup failed");
  return null;
}

/** Turn LRC lines into our ribbon's shape, with no per-word timing yet (lrcAlign fills that in). */
export function lrcToLines(lrc: LrcLine[], duration: number): LyricsLine[] {
  return lrc.map((l, i) => ({
    start: l.t,
    end: i + 1 < lrc.length ? lrc[i + 1].t : Math.max(l.t + 4, duration),
    text: l.text,
  }));
}
