// A track is identified by its YouTube videoId everywhere in the app. Tracks that
// originate from another catalog (Spotify, Tidal, …) carry their provenance
// anchors instead and are resolved to a playable videoId on load (see
// @htl/media resolvePlayable) — videoId may be empty until then.
export interface TrackMeta {
  videoId: string;
  title: string;
  artist: string; // uploader / channel / artist
  duration: number; // seconds
  thumbnail: string | null;
  views: number | null;
  bpm?: number | null; // filled in once analyzed on load
  key?: string | null; // Camelot code (e.g. "8B"), filled in once analyzed
  addedAt?: number; // epoch ms, set when added to the collection
  // Cross-service anchors (present on tracks sourced from another catalog).
  isrc?: string | null; // universal recording id, used to match across services
  provider?: string; // "youtube" | "spotify" | "tidal" | "htl"
  providerId?: string | null; // the track's id within that provider
}

export interface Playlist {
  id: string;
  name: string;
  trackIds: string[]; // videoIds, in order
  sourceListId?: string; // YouTube/Spotify playlist id this was imported from (dedup re-imports)
  sourceService?: string; // "youtube" | "spotify" | … — which service section it belongs to
}
