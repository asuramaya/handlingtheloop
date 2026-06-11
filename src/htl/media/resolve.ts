// The bridge between the catalog layer (any service's tracks) and the decode
// engine (YouTube). Every track a deck loads passes through here. YouTube tracks
// pass straight through; a track from any other provider (Spotify today, Tidal
// tomorrow) is matched ONCE to a YouTube video via the free innertube search and
// the resolution is cached for the session — this is the "id system" the
// playlists sit on top of. ISRC is the universal cross-service key; provider id
// and a normalized title/artist query are the fallbacks.
import { searchYouTube } from "./api";

// Provider-agnostic track. Any catalog (YouTube, Spotify, Tidal, native htl)
// normalizes to this shape before it can be played.
export interface CatalogTrack {
  title: string;
  artist: string;
  duration: number; // seconds (0 if unknown)
  videoId?: string | null; // YouTube id, when the track already is one
  isrc?: string | null; // universal recording id (Spotify/Tidal/Apple expose it)
  provider?: string; // "youtube" | "spotify" | "tidal" | "htl" — provenance, for UI
  providerId?: string | null; // the track's id within that provider
}

export interface Playable {
  engine: "youtube";
  videoId: string;
  matched: boolean; // true if we had to resolve it (vs. it already being a videoId)
}

// Session cache: anchor -> resolved videoId, so re-loading a matched track (or the
// other deck) is instant and costs no search.
const cache = new Map<string, string>();

function anchorKey(t: CatalogTrack): string {
  if (t.isrc) return `isrc:${t.isrc.toUpperCase()}`;
  if (t.provider && t.providerId) return `${t.provider}:${t.providerId}`;
  return `q:${t.artist.toLowerCase()}|${t.title.toLowerCase()}`;
}

// Strip the cross-service search noise ("Official Video", "feat.", brackets…).
function cleanQuery(artist: string, title: string): string {
  return `${artist} ${title}`
    .replace(/\([^)]*\)/g, " ")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\b(official|video|audio|lyrics?|hd|hq|mv|visualizer|remaster(?:ed)?|feat\.?|ft\.?)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Resolve any catalog track to something a deck can decode. A YouTube track is
 * returned as-is; anything else is matched to a YouTube video (and cached).
 * Throws if no match is found so the caller can surface it on the deck.
 */
export async function resolvePlayable(t: CatalogTrack, signal?: AbortSignal): Promise<Playable> {
  if (t.videoId) return { engine: "youtube", videoId: t.videoId, matched: false };

  const key = anchorKey(t);
  const hit = cache.get(key);
  if (hit) return { engine: "youtube", videoId: hit, matched: true };

  const results = await searchYouTube(cleanQuery(t.artist, t.title), 5, signal);
  // Prefer a duration-agreeing result when we know the source duration — it weeds
  // out edits / extended mixes / sped-up reuploads the top hit sometimes is.
  const pick =
    (t.duration > 0 ? results.find((r) => Math.abs((r.duration ?? 0) - t.duration) <= 12) : undefined) ?? results[0];
  if (!pick?.videoId) throw new Error(`No YouTube match for “${t.artist} — ${t.title}”`);

  cache.set(key, pick.videoId);
  return { engine: "youtube", videoId: pick.videoId, matched: true };
}

/** Pre-seed the cache (e.g. from a user-confirmed sync match) so a later load skips the search. */
export function rememberResolution(t: CatalogTrack, videoId: string): void {
  cache.set(anchorKey(t), videoId);
}
