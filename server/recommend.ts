import type { TrackMeta } from "./youtube";
import type { BrowseAuth, InnertubeApi } from "./innertube";

// Layered "what plays next after videoId" recommender. Tiers run best-first and each one only
// has to fill what the ones above it left; every tier is allowed to fail, and the last is
// guaranteed to answer.
//
// Tier A — PROVIDER RADIO (TIDAL track-radio, resolved back to videoIds via ISRC). Music-aware
// and catalogue-clean, but it needs a token and a seed we can find in the catalogue, so it is
// often unavailable. See server/providerRadio.ts. SPOTIFY IS INTENTIONALLY EXCLUDED — its
// /recommendations, related-artists and audio-features endpoints were deprecated (Nov 2024) for
// the vast majority of apps, so there is no Spotify suggestion path to build on.
//
// Tier B — YOUTUBE MUSIC RADIO (the `RDAMVM<videoId>` mix). New, and it should carry most of the
// weight in practice: it needs no credentials, works for anything YouTube considers music, and —
// unlike Tier C — it is a SEQUENCE rather than a recommendation surface. YouTube Music built it
// to be played in order, so it is already doing the job we are asking for.
//
// Tier C — YOUTUBE WATCH-NEXT. The universal spine and the floor that guarantees candidates:
// every track in the app resolves to a YouTube videoId before it decodes, so this works
// regardless of the track's original catalogue. But it is a CLICK-optimising surface — the
// uploader's other uploads, reaction videos, whatever is trending — which is why the parser has
// to filter it back down with YouTube's own MUSIC badge, and why it is last rather than first.
//
// Tier D — library smart-sort — is purely client-side (it re-orders the user's own collection by
// mixability) and never reaches this route.

export interface RecommendOpts {
  provider?: string | null;
  limit?: number;
  // Tier A — supplied by the route when the seed has the right provenance and a token is
  // available (already authed + resolved to videoIds). Merged AHEAD of everything else.
  providerRadio?: () => Promise<TrackMeta[]>;
  /** Skip the YouTube Music tier (tests, or a caller that only wants the raw spine). */
  skipMusicRadio?: boolean;
}

export async function recommendNext(
  api: Pick<InnertubeApi, "getWatchNext"> & Partial<Pick<InnertubeApi, "getMusicRadio">>,
  videoId: string,
  opts: RecommendOpts = {},
  auth?: BrowseAuth,
): Promise<TrackMeta[]> {
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 60);
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
      /* provider radio failed — fall through */
    }
  }

  // Tier B — YouTube Music's own track radio. A curated sequence, not a click surface.
  if (out.length < limit && api.getMusicRadio && !opts.skipMusicRadio) {
    try {
      add(await api.getMusicRadio(videoId, auth));
    } catch {
      /* no music radio for this video — fall through to the spine */
    }
  }

  // Tier C — YouTube watch-next spine. The universal floor; tolerate failure.
  if (out.length < limit) {
    try {
      add(await api.getWatchNext(videoId, auth));
    } catch {
      /* return whatever we have (possibly empty) */
    }
  }

  return out.slice(0, limit);
}
