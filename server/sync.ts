// Cross-service playlist sync, two-phase so the user can REVIEW matches before
// anything is written (the SongShift/FreeYourMusic pattern the research flagged
// as the differentiator):
//   1. readSource      — fetch the source playlist's tracks (+ anchors).
//   2. matchTracks     — for a slice of tracks, find ranked candidates on the
//                        destination with a confidence tier. NO writes. Paged by
//                        the client to stay under the Worker subrequest cap and
//                        to show progress.
//   3. createDestPlaylist / addToDestPlaylist — commit only the confirmed picks.
//
// Matching uses the FREE innertube search for →YouTube (Data API search.list
// costs 100 quota units; we avoid it), and Spotify search for →Spotify. IDs/ISRC
// ride along as anchors for future incremental re-sync.
import { type ConnEnv, getValidToken } from "./connections";
import { addToYouTubePlaylist, createYouTubePlaylist, fetchPlaylistData } from "./ytdata";
import {
  addSpotifyTracks,
  createSpotifyPlaylist,
  getSpotifyPlaylistTracks,
  getSpotifyUserId,
  searchSpotifyTracks,
} from "./spotifyData";
import { type Candidate, type Confidence, confidenceOf, rank } from "./match";

export type Service = "youtube" | "spotify";
const providerOf = (s: Service): "google" | "spotify" => (s === "youtube" ? "google" : "spotify");

export interface SourceTrack {
  title: string;
  artist: string;
  duration: number;
  thumbnail: string | null;
  isrc: string | null;
  spotifyId: string | null;
  videoId: string | null;
}

export interface MatchRow {
  index: number;
  source: SourceTrack;
  best: Candidate | null;
  confidence: Confidence;
  alternatives: Candidate[];
}

// Injected YouTube search (the worker owns the innertube instance).
export interface SyncDeps {
  searchYouTube(
    query: string,
    limit?: number,
  ): Promise<{ videoId: string; title: string; artist: string; duration: number; thumbnail: string | null }[]>;
}

// Strip the noise that wrecks cross-service search ("Official Video", "feat.", …).
function cleanQuery(artist: string, title: string): string {
  return `${artist} ${title}`
    .replace(/\([^)]*\)/g, " ")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\b(official|video|audio|lyrics?|hd|hq|mv|visualizer|remaster(?:ed)?|feat\.?|ft\.?)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Phase 1: read the source playlist's tracks with whatever anchors it carries. */
export async function readSource(
  env: ConnEnv,
  userId: string,
  source: Service,
  playlistId: string,
): Promise<{ name: string; tracks: SourceTrack[] }> {
  const token = await getValidToken(env, userId, providerOf(source));
  if (!token) throw new Error(`${source} is not connected`);

  if (source === "spotify") {
    const tracks = await getSpotifyPlaylistTracks(token, playlistId);
    return {
      name: "Playlist",
      tracks: tracks.map((t) => ({
        title: t.title,
        artist: t.artist,
        duration: t.duration,
        thumbnail: t.thumbnail,
        isrc: t.isrc,
        spotifyId: t.spotifyId,
        videoId: null,
      })),
    };
  }

  const r = await fetchPlaylistData(token, playlistId);
  return {
    name: r.title,
    tracks: r.tracks.map((t) => ({
      title: t.title,
      artist: t.artist,
      duration: t.duration,
      thumbnail: t.thumbnail,
      isrc: null,
      spotifyId: null,
      videoId: t.videoId,
    })),
  };
}

/** Phase 2: match a slice of source tracks on the destination. No writes. */
export async function matchTracks(
  env: ConnEnv,
  userId: string,
  dest: Service,
  tracks: SourceTrack[],
  startIndex: number,
  deps: SyncDeps,
): Promise<MatchRow[]> {
  let spotifyToken: string | null = null;
  if (dest === "spotify") {
    spotifyToken = await getValidToken(env, userId, "spotify");
    if (!spotifyToken) throw new Error("spotify is not connected");
  }

  const rows: MatchRow[] = [];
  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i];
    const q = cleanQuery(t.artist, t.title);
    let candidates: Candidate[] = [];
    try {
      if (dest === "youtube") {
        const res = await deps.searchYouTube(q, 5);
        candidates = res.map((r) => ({
          id: r.videoId,
          kind: "video" as const,
          title: r.title,
          artist: r.artist,
          duration: r.duration,
          thumbnail: r.thumbnail,
        }));
      } else {
        candidates = await searchSpotifyTracks(spotifyToken!, q, 5);
      }
    } catch {
      candidates = [];
    }
    const ranked = rank({ title: t.title, artist: t.artist, duration: t.duration }, candidates);
    const best = ranked[0] ?? null;
    rows.push({
      index: startIndex + i,
      source: t,
      best: best?.cand ?? null,
      confidence: best ? confidenceOf(best.score) : "none",
      alternatives: ranked.slice(0, 5).map((r) => r.cand),
    });
  }
  return rows;
}

/** Free-text search of the destination service (for manual per-track re-match). */
export async function searchDest(
  env: ConnEnv,
  userId: string,
  dest: Service,
  query: string,
  deps: SyncDeps,
): Promise<Candidate[]> {
  if (dest === "youtube") {
    const res = await deps.searchYouTube(query, 6);
    return res.map((r) => ({
      id: r.videoId,
      kind: "video" as const,
      title: r.title,
      artist: r.artist,
      duration: r.duration,
      thumbnail: r.thumbnail,
    }));
  }
  const token = await getValidToken(env, userId, "spotify");
  if (!token) throw new Error("spotify is not connected");
  return searchSpotifyTracks(token, query, 6);
}

/** Phase 3a: create the (private) destination playlist. */
export async function createDestPlaylist(
  env: ConnEnv,
  userId: string,
  dest: Service,
  name: string,
): Promise<{ playlistId: string; url: string }> {
  const token = await getValidToken(env, userId, providerOf(dest));
  if (!token) throw new Error(`${dest} is not connected`);
  if (dest === "youtube") {
    const id = await createYouTubePlaylist(token, name, "Synced via handlingtheloop.com");
    return { playlistId: id, url: `https://www.youtube.com/playlist?list=${id}` };
  }
  const user = await getSpotifyUserId(token);
  const id = await createSpotifyPlaylist(token, user, name, "Synced via handlingtheloop.com");
  return { playlistId: id, url: `https://open.spotify.com/playlist/${id}` };
}

/** Phase 3b: append a chunk of confirmed ids (videoIds for YT, uris for Spotify). */
export async function addToDestPlaylist(
  env: ConnEnv,
  userId: string,
  dest: Service,
  playlistId: string,
  ids: string[],
): Promise<number> {
  const token = await getValidToken(env, userId, providerOf(dest));
  if (!token) throw new Error(`${dest} is not connected`);
  if (dest === "youtube") {
    let added = 0;
    for (const videoId of ids) {
      await addToYouTubePlaylist(token, playlistId, videoId);
      added++;
    }
    return added;
  }
  await addSpotifyTracks(token, playlistId, ids); // ids are spotify uris
  return ids.length;
}
