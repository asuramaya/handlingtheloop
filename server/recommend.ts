import type { TrackMeta } from "./youtube";
import type { BrowseAuth, InnertubeApi } from "./innertube";

// Layered "what plays next after videoId" recommender.
//
// Tier B — YouTube watch-next — is the UNIVERSAL SPINE: every track in the app
// resolves to a YouTube videoId before it decodes, so this works regardless of
// the track's original catalog (YouTube/Spotify/Tidal/…). It is always run and is
// the floor that guarantees we have candidates.
//
// Tier A — provider radio (Tidal / YT-Music "go to radio") — is an optional
// booster wired in a later sub-phase: when the seed came from a provider we have a
// token for, fetch that provider's track-radio and resolve each result back to a
// videoId via ISRC, then prepend. SPOTIFY IS INTENTIONALLY EXCLUDED — its
// /recommendations, related-artists and audio-features endpoints were deprecated
// (Nov 2024) for the vast majority of apps, so there is no Spotify suggestion path.
//
// Tier C — library smart-sort — is purely client-side (it re-orders the user's own
// collection by mixability) and never reaches this route.

export interface RecommendOpts {
  provider?: string | null;
  limit?: number;
}

export async function recommendNext(
  api: Pick<InnertubeApi, "getWatchNext">,
  videoId: string,
  opts: RecommendOpts = {},
  auth?: BrowseAuth,
): Promise<TrackMeta[]> {
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 50);
  const seen = new Set<string>([videoId]);
  const out: TrackMeta[] = [];
  const add = (list: TrackMeta[]): void => {
    for (const t of list) {
      if (!t.videoId || seen.has(t.videoId)) continue;
      seen.add(t.videoId);
      out.push(t);
      if (out.length >= limit) return;
    }
  };

  // Tier A — provider radio booster (placeholder; resolves to nothing until the
  // provider radio endpoints + ISRC resolve are wired). Kept here so the merge
  // order (provider first, then the YouTube floor) is already correct.
  // if (opts.provider) add(await providerRadio(opts.provider, videoId, auth));

  // Tier B — YouTube watch-next spine. Tolerate failure (rate limit / parse drift):
  // a recommender that 500s would break the queue, so we degrade to "no suggestions".
  try {
    add(await api.getWatchNext(videoId, auth));
  } catch {
    /* return whatever we have (possibly empty) */
  }

  return out.slice(0, limit);
}
