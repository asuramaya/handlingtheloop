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
  // Tier A — provider radio (Tidal/YT-Music). The route supplies this closure
  // (already token-authed + resolved to videoIds) when the seed has the right
  // provenance + a connected token; it is merged AHEAD of YouTube. Tidal's radio
  // endpoint is still env-gated/unverified (see server/tidalData.ts), so the live
  // routes leave this unset today and the YouTube spine carries the feed.
  providerRadio?: () => Promise<TrackMeta[]>;
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

  // Tier A — provider radio (music-aware, genre/vibe-tight) takes precedence.
  if (opts.providerRadio) {
    try {
      add(await opts.providerRadio());
    } catch {
      /* provider radio failed — fall through to the YouTube floor */
    }
  }

  // Tier B — YouTube watch-next spine. The universal floor; tolerate failure.
  if (out.length < limit) {
    try {
      add(await api.getWatchNext(videoId, auth));
    } catch {
      /* return whatever we have (possibly empty) */
    }
  }

  return out.slice(0, limit);
}
