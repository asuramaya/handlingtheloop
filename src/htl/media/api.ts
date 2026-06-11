import type { TrackMeta } from "../library/types";
import { ytAuthHeaders } from "./auth";

// Client wrappers over the /api/* endpoints.

async function getJson<T>(url: string, signal?: AbortSignal, headers?: Record<string, string>): Promise<T> {
  const res = await fetch(url, { signal, headers });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error || `HTTP ${res.status}`);
  return body as T;
}

export async function searchYouTube(
  query: string,
  limit = 25,
  signal?: AbortSignal,
): Promise<TrackMeta[]> {
  const { results } = await getJson<{ results: TrackMeta[] }>(
    `/api/search?q=${encodeURIComponent(query)}&limit=${limit}`,
    signal,
  );
  return results;
}

export async function fetchPlaylist(
  listOrUrl: string,
  signal?: AbortSignal,
): Promise<{ title: string; tracks: TrackMeta[] }> {
  // Send auth so the user's PRIVATE playlists resolve too (public ones don't need it).
  return getJson(`/api/playlist?list=${encodeURIComponent(listOrUrl)}`, signal, await ytAuthHeaders());
}

/** A YouTube playlist the signed-in user owns/follows. */
export interface MyPlaylist {
  id: string;
  title: string;
  count: number;
  thumbnail: string | null;
}

/** The signed-in user's own YouTube playlists (requires Google sign-in). */
export async function fetchMyPlaylists(signal?: AbortSignal): Promise<MyPlaylist[]> {
  const { playlists } = await getJson<{ playlists: MyPlaylist[] }>("/api/me/playlists", signal, await ytAuthHeaders());
  return playlists;
}

export async function fetchMeta(videoId: string, signal?: AbortSignal): Promise<TrackMeta> {
  return getJson(`/api/meta?v=${encodeURIComponent(videoId)}`, signal, await ytAuthHeaders());
}

/** The shared community pool: tracks already cached in R2 (loadable instantly, no resolve). */
export async function fetchCommunity(limit = 60, signal?: AbortSignal): Promise<TrackMeta[]> {
  const { tracks } = await getJson<{ tracks: TrackMeta[] }>(`/api/community?limit=${limit}`, signal);
  return tracks;
}

/** Contribute a track's analysis (BPM/key/grid) to the shared dataset. Best-effort. */
export async function postAnalysis(a: {
  videoId: string;
  bpm?: number | null;
  key?: string | null;
  keyName?: string | null;
  beatOffset?: number | null;
  duration?: number | null;
}): Promise<void> {
  await fetch("/api/analysis", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(a),
  }).catch(() => {
    /* best-effort */
  });
}

/** Durably backfill a community track's metadata (shared sidecar). Best-effort. */
export async function putCommunityMeta(t: {
  videoId: string;
  title: string;
  artist: string;
  duration: number;
  thumbnail: string | null;
}): Promise<void> {
  await fetch("/api/community/meta", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(t),
  }).catch(() => {
    /* best-effort — local cache still applies */
  });
}

/** Pull a YouTube video id out of a URL (watch / youtu.be / shorts / embed) or a
 *  bare 11-char id. Returns null if there's no video id (e.g. a playlist URL). */
export function parseVideoId(input: string): string | null {
  const s = input.trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  try {
    const u = new URL(s);
    const host = u.hostname.replace(/^www\./, "");
    if (host === "youtu.be") {
      const id = u.pathname.slice(1, 12);
      return /^[\w-]{11}$/.test(id) ? id : null;
    }
    if (host.endsWith("youtube.com") || host.endsWith("youtube-nocookie.com")) {
      const v = u.searchParams.get("v");
      if (v && /^[\w-]{11}$/.test(v)) return v;
      const m = u.pathname.match(/\/(?:shorts|embed|v|live)\/([\w-]{11})/);
      if (m) return m[1];
    }
  } catch {
    /* not a url */
  }
  return null;
}

/** Pull a YouTube playlist id out of a URL (or accept a bare list id). */
export function parsePlaylistId(input: string): string | null {
  const s = input.trim();
  if (/^PL[\w-]+$|^[\w-]{13,}$/.test(s) && !s.includes("/")) return s;
  try {
    const u = new URL(s);
    const list = u.searchParams.get("list");
    if (list) return list;
  } catch {
    /* not a url */
  }
  return null;
}
