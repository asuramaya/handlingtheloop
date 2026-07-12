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

// SOFT length backstop: keeps hour-long mixes/livestreams/loops off a deck. Mirrors
// server/innertube.ts MAX_TRACK_SECONDS. No longer the "is this a song" filter — that's
// YouTube Music's typed `song` shelf now (server searchYouTube), so legit long songs load.
export const MAX_TRACK_SECONDS = 30 * 60;

export interface Playlist {
  id: string;
  name: string;
  trackIds: string[]; // videoIds, in order
  sourceListId?: string; // YouTube/Spotify playlist id this was imported from (dedup re-imports)
  sourceService?: string; // "youtube" | "spotify" | … — which service section it belongs to
  lastSynced?: number; // epoch ms of the last re-sync from the source provider
  // Spotify/TIDAL only: stable SOURCE-track key (isrc / spotifyId / artist|title) → the matched
  // YouTube videoId. Lets re-sync dedup by SOURCE identity instead of the fuzzy match (which drifts
  // to a different video for the same song across runs and used to accrete duplicates forever), and
  // prune only tracks whose source row is actually gone — never manual additions. Absent on YouTube
  // (exact-id) and legacy playlists (they just re-match afresh once).
  sourceMatch?: Record<string, string>;
}
