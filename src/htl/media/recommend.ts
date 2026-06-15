import type { TrackMeta } from "../library/types";
import { ytAuthHeaders } from "./auth";

// Client wrapper over /api/recommend — the auto-mix / radio "what plays next"
// feed for a given track. Candidates come back unscored (raw order); the queue
// re-ranks them by mixability against the currently-playing track.

export interface RecommendOpts {
  provider?: string | null; // seed track's catalog, to try provider-radio first
  isrc?: string | null; // seed's ISRC — lets the server seed TIDAL track-radio directly
  title?: string | null; // seed title/artist — lets the server FIND the seed on TIDAL
  artist?: string | null; // (a YouTube seed has no ISRC, so we match it by name)
  limit?: number;
  signal?: AbortSignal;
}

export async function fetchRecommendations(videoId: string, opts: RecommendOpts = {}): Promise<TrackMeta[]> {
  const params = new URLSearchParams({ v: videoId });
  if (opts.provider) params.set("provider", opts.provider);
  if (opts.isrc) params.set("isrc", opts.isrc);
  if (opts.title) params.set("title", opts.title);
  if (opts.artist) params.set("artist", opts.artist);
  if (opts.limit) params.set("limit", String(opts.limit));
  const res = await fetch(`/api/recommend?${params.toString()}`, {
    signal: opts.signal,
    headers: await ytAuthHeaders(),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error || `HTTP ${res.status}`);
  return (body as { candidates?: TrackMeta[] }).candidates ?? [];
}
