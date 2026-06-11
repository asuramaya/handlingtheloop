// Playback sources, kept deliberately abstract so the deck never knows where a
// track came from.
//
// HARD CONSTRAINT: a browser can only DECODE audio to PCM (for waveform /
// beatmatch / key / stems / scratch) from a YouTube direct stream or a local
// file. Spotify, Tidal, Apple Music, etc. lock their audio behind DRM (Widevine
// EME) — you get an opaque player, never the samples. So those services can NEVER
// be a decode engine here; they act purely as CATALOG providers whose tracks
// resolve onto the YouTube decode engine via the ID matcher (see resolve.ts).
//
// A "source" therefore bundles two independent choices:
//   - engine + tier : how the decodable audio is fetched (YouTube anon vs the
//                      user's Premium account → ad-free / higher-bitrate itags).
//   - catalog       : whose library/playlists sit on top (matched by id).
// Adding Tidal later = append one entry here + a catalog adapter; nothing in the
// deck or the resolver changes.

export type CredentialTier = "anonymous" | "premium";
export type DecodeEngine = "youtube"; // the only in-browser stream decode engine
export type Catalog = "youtube" | "spotify" | "tidal";

export interface StreamSource {
  id: string; // stable key, persisted in settings.streamSource
  label: string;
  hint: string; // shown on hover — explains exactly what this does
  icon: string;
  engine: DecodeEngine;
  tier: CredentialTier; // credential forwarded to the engine
  catalog: Catalog; // which library this browses
  /** False = present in the picker but its catalog/browse isn't wired up yet. */
  catalogReady: boolean;
}

// Streaming is anonymous-only: decode needs a YouTube DIRECT stream (ANDROID_VR),
// which authenticated/Premium credentials can't unlock here, so there's exactly one
// source. Accounts (YouTube/Spotify) are PLAYLIST-ONLY — they never touch streaming.
export const STREAM_SOURCES: StreamSource[] = [
  {
    id: "yt-anonymous",
    label: "YouTube",
    hint: "Anonymous YouTube streaming. No account needed.",
    icon: "🕶",
    engine: "youtube",
    tier: "anonymous",
    catalog: "youtube",
    catalogReady: true,
  },
];

export const DEFAULT_SOURCE = "yt-anonymous";

export function getSource(id: string): StreamSource {
  return STREAM_SOURCES.find((s) => s.id === id) ?? STREAM_SOURCES[0];
}

/** The next source in the registry (for a cycle-on-click picker). */
export function nextSource(id: string): StreamSource {
  const i = STREAM_SOURCES.findIndex((s) => s.id === id);
  return STREAM_SOURCES[(i + 1) % STREAM_SOURCES.length];
}
