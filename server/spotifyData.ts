// Spotify Web API reads/writes for the sync feature, authenticated by a Bearer
// token (resolved via connections.ts). Pure-JS fetch.
import type { MyPlaylist } from "./innertube";
import type { TrackMeta } from "./youtube";
import type { Candidate } from "./match";

const API = "https://api.spotify.com/v1";
const TIMEOUT_MS = 8000;

async function sget(urlOrPath: string, token: string): Promise<Record<string, unknown>> {
  const url = urlOrPath.startsWith("http") ? urlOrPath : `${API}${urlOrPath}`;
  // The only absolute URLs we follow are Spotify's own `next` pagination links.
  // Pin the host so a malformed/hostile value can never send the user's Bearer
  // token to another origin (SSRF / token-exfiltration defense-in-depth).
  if (new URL(url).host !== "api.spotify.com") throw new Error("refusing non-Spotify URL");
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  // Read text first so we can surface a body even when Spotify returns no JSON
  // error envelope (some 403s are empty), and name the endpoint that failed.
  const text = await res.text();
  let j: Record<string, unknown> = {};
  try {
    j = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    /* non-JSON body */
  }
  if (!res.ok) {
    const endpoint = urlOrPath.replace(/^https?:\/\/[^/]+/, "").split("?")[0];
    const err = (j.error as { message?: string })?.message || text.slice(0, 160);
    throw new Error(`spotify ${res.status}${err ? `: ${err}` : ""} [${endpoint}]`);
  }
  return j;
}

interface SpotifyImage {
  url: string;
}
interface SpotifyPlaylist {
  id: string;
  name?: string;
  images?: SpotifyImage[];
  tracks?: { total?: number };
}

/** The user's own/followed Spotify playlists. */
export async function getMySpotifyPlaylists(token: string): Promise<MyPlaylist[]> {
  const out: MyPlaylist[] = [];
  let url: string | null = "/me/playlists?limit=50";
  while (url) {
    const j = await sget(url, token);
    for (const p of (j.items as SpotifyPlaylist[]) ?? []) {
      if (!p.id) continue;
      out.push({
        id: p.id,
        title: p.name || "Playlist",
        count: p.tracks?.total ?? 0,
        thumbnail: p.images?.[0]?.url ?? null,
      });
    }
    url = (j.next as string | null) ?? null;
  }
  return out;
}

async function spost(path: string, token: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const err = (j.error as { message?: string })?.message;
    throw new Error(`spotify ${res.status}${err ? `: ${err}` : ""}`);
  }
  return j;
}

/** The current Spotify user's id (needed to create a playlist under their account). */
export async function getSpotifyUserId(token: string): Promise<string> {
  const j = await sget("/me", token);
  const id = (j as { id?: string }).id;
  if (!id) throw new Error("could not read Spotify user id");
  return id;
}

interface SpotifySearchTrack {
  uri: string;
  name?: string;
  artists?: { name?: string }[];
}

/** Best-match a single track by free-text query (artist + title), or null. */
export async function searchSpotifyTrack(token: string, query: string): Promise<{ uri: string; label: string } | null> {
  const j = await sget(`/search?type=track&limit=1&q=${encodeURIComponent(query)}`, token);
  const item = ((j.tracks as { items?: SpotifySearchTrack[] })?.items ?? [])[0];
  if (!item?.uri) return null;
  const label = `${(item.artists ?? []).map((a) => a.name).filter(Boolean).join(", ")} — ${item.name ?? ""}`;
  return { uri: item.uri, label };
}

interface SpotifyFullTrack {
  uri: string;
  name?: string;
  duration_ms?: number;
  artists?: { name?: string }[];
  album?: { images?: SpotifyImage[] };
}

/** Top candidate matches for review/re-match (Candidate shape from match.ts). */
export async function searchSpotifyTracks(token: string, query: string, limit = 5): Promise<Candidate[]> {
  const j = await sget(`/search?type=track&limit=${limit}&q=${encodeURIComponent(query)}`, token);
  const items = (j.tracks as { items?: SpotifyFullTrack[] })?.items ?? [];
  return items
    .filter((t) => t.uri)
    .map((t) => ({
      id: t.uri,
      kind: "uri" as const,
      title: t.name || "",
      artist: (t.artists ?? []).map((a) => a.name).filter(Boolean).join(", "),
      duration: t.duration_ms ? Math.round(t.duration_ms / 1000) : 0,
      thumbnail: t.album?.images?.[0]?.url ?? null,
    }));
}

/** Create a private playlist under the user, returning its id. */
export async function createSpotifyPlaylist(
  token: string,
  userId: string,
  name: string,
  description = "",
): Promise<string> {
  const j = await spost(`/users/${encodeURIComponent(userId)}/playlists`, token, {
    name,
    description,
    public: false,
  });
  const id = (j as { id?: string }).id;
  if (!id) throw new Error("Spotify playlist create returned no id");
  return id;
}

/** Add track uris to a playlist (Spotify caps adds at 100 per request).
    Feb-2026 API migration: POST /playlists/{id}/tracks → /items (body `uris` same). */
export async function addSpotifyTracks(token: string, playlistId: string, uris: string[]): Promise<void> {
  for (let i = 0; i < uris.length; i += 100) {
    await spost(`/playlists/${encodeURIComponent(playlistId)}/items`, token, { uris: uris.slice(i, i + 100) });
  }
}

// Feb-2026 API migration renamed the playlist-items page field `track` → `item`.
interface SpotifyTrackItem {
  item?: {
    id?: string;
    name?: string;
    duration_ms?: number;
    artists?: { name?: string }[];
    album?: { images?: SpotifyImage[]; name?: string };
    external_ids?: { isrc?: string };
    is_local?: boolean;
  };
}

/** A normalized track from a Spotify playlist, carrying ISRC for cross-matching. */
export interface SpotifyTrack extends TrackMeta {
  isrc: string | null;
  spotifyId: string | null;
}

/** A Spotify playlist's tracks (paginated), normalized + ISRC-tagged.
    Feb-2026 API migration: GET /playlists/{id}/tracks → /items (Dev-Mode apps now
    403 on the old /tracks path); each page row holds the track under `item`. */
export async function getSpotifyPlaylistTracks(token: string, playlistId: string): Promise<SpotifyTrack[]> {
  const out: SpotifyTrack[] = [];
  // market=from_token relinks tracks to the user's region (avoids spurious
  // unavailability) and is required for some playlists to return tracks at all.
  let url: string | null = `/playlists/${encodeURIComponent(playlistId)}/items?limit=100&additional_types=track&market=from_token`;
  while (url) {
    const j = await sget(url, token);
    for (const it of (j.items as SpotifyTrackItem[]) ?? []) {
      const t = it.item;
      if (!t || !t.id || t.is_local) continue;
      out.push({
        videoId: "", // unknown until matched on YouTube
        title: t.name || "",
        artist: (t.artists ?? []).map((a) => a.name).filter(Boolean).join(", "),
        duration: t.duration_ms ? Math.round(t.duration_ms / 1000) : 0,
        thumbnail: t.album?.images?.[0]?.url ?? null,
        views: null,
        isrc: t.external_ids?.isrc ?? null,
        spotifyId: t.id,
      });
    }
    url = (j.next as string | null) ?? null;
  }
  return out;
}
