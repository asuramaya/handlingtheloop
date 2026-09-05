import type { TrackMeta } from "./youtube";
import { cleanVideoTitle } from "./youtube";
import { getTidalTrackRadio, tidalTrackIdByIsrc, searchTidalTracks } from "./tidalData";

// TIER A of the recommender — TIDAL's track radio, resolved back to playable videoIds.
//
// ★ WHY THIS IS ITS OWN MODULE. It used to live inline in the Cloudflare worker's route handler,
// and the dev server route simply did not have it: `server/api.ts` read only `v`, `limit` and
// `provider`, and dropped the `isrc`, `title` and `artist` the client had gone to the trouble of
// sending. So `pnpm dev` exercised a strictly WORSE recommender than production — the YouTube
// floor alone — and every hour spent tuning the radio locally was tuning the fallback path. One
// implementation, two callers, is the fix.
//
// ★ AND WHY THE CACHE IS NOT OPTIONAL IN PRODUCTION. TIDAL returns catalogue tracks; a deck needs
// a videoId. Resolving one meant one YouTube SEARCH per radio result — eight per seed, up to
// three seeds, twenty-four searches on a single /api/recommend. That is slow enough to blow a
// Worker's subrequest budget and fragile enough that the tier probably failed soft and silently
// fell through to the floor most of the time, which is a good part of why the "provider radio"
// tier never seemed to do anything. An ISRC→videoId mapping never changes, so it is cached
// permanently and the second lookup of a track costs nothing.

/** Permanent ISRC → videoId memo. Backed by D1 in the worker; absent in dev (no database). */
export interface IsrcVideoCache {
  get(isrcs: string[]): Promise<Map<string, { videoId: string; title: string; artist: string }>>;
  put(rows: { isrc: string; videoId: string; title: string; artist: string }[]): Promise<void>;
}

export interface ProviderRadioDeps {
  /** A TIDAL bearer token (user token, else client-credentials app token). Null → tier disabled. */
  token: () => Promise<string | null>;
  searchYouTube: (query: string, limit: number) => Promise<TrackMeta[]>;
  cache?: IsrcVideoCache;
  /** How many radio results to resolve. Each uncached one costs a YouTube search. */
  resolve?: number;
}

export interface RadioSeed {
  isrc?: string | null;
  title?: string | null;
  artist?: string | null;
}

/** Build the Tier-A closure for a seed, or undefined when there is nothing to seed TIDAL with.
 *  Never throws: every failure path returns [] so the YouTube floor still answers the request. */
export function makeProviderRadio(seed: RadioSeed, deps: ProviderRadioDeps): (() => Promise<TrackMeta[]>) | undefined {
  if (!seed.isrc && !seed.title) return undefined;
  const want = deps.resolve ?? 10;

  return async () => {
    try {
      const token = await deps.token();
      if (!token) return [];

      // Find the seed in TIDAL's catalogue: by ISRC when we know it, else by name. A YouTube seed
      // has no ISRC, and its raw uploader title ("… (Official Video) [HD] 1080p") never matches a
      // catalogue — so it goes through the same cleaner the search box uses.
      let tid = seed.isrc ? await tidalTrackIdByIsrc(token, seed.isrc) : null;
      if (!tid && seed.title) {
        const q = [cleanVideoTitle(seed.title) || seed.title, seed.artist ?? ""].join(" ").trim();
        tid = (await searchTidalTracks(token, q, 1))[0]?.id ?? null;
      }
      if (!tid) return [];

      const radio = (await getTidalTrackRadio(token, tid, want * 2)).slice(0, want);
      if (!radio.length) return [];

      // Cache first: whatever we have already resolved costs nothing and needs no search.
      const withIsrc = radio.filter((t) => !!t.isrc).map((t) => t.isrc as string);
      const cached = deps.cache && withIsrc.length ? await deps.cache.get(withIsrc) : new Map();

      const fresh: { isrc: string; videoId: string; title: string; artist: string }[] = [];
      const resolved = await Promise.all(
        radio.map(async (t): Promise<TrackMeta | null> => {
          const hit = t.isrc ? cached.get(t.isrc) : undefined;
          if (hit) {
            return {
              videoId: hit.videoId,
              title: t.title || hit.title,
              artist: t.artist || hit.artist,
              duration: 0,
              thumbnail: `/api/art/${hit.videoId}`,
              views: null,
              isrc: t.isrc,
              provider: "tidal",
            };
          }
          try {
            const found = (await deps.searchYouTube(`${t.artist} ${t.title}`.trim(), 1))[0];
            if (!found?.videoId) return null;
            if (t.isrc) fresh.push({ isrc: t.isrc, videoId: found.videoId, title: t.title || found.title, artist: t.artist || found.artist });
            return { ...found, title: t.title || found.title, artist: t.artist || found.artist, isrc: t.isrc, provider: "tidal" };
          } catch {
            return null;
          }
        }),
      );

      // Write-behind: a failed cache write must never cost the caller its results.
      if (deps.cache && fresh.length) {
        try {
          await deps.cache.put(fresh);
        } catch {
          /* the mapping will just be re-derived next time */
        }
      }
      return resolved.filter((x): x is TrackMeta => !!x);
    } catch {
      return []; // fail soft — recommendNext falls through to the YouTube spine
    }
  };
}
