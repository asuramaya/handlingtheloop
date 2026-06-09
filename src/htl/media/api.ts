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
  return getJson(`/api/playlist?list=${encodeURIComponent(listOrUrl)}`, signal);
}

export async function fetchMeta(videoId: string, signal?: AbortSignal): Promise<TrackMeta> {
  return getJson(`/api/meta?v=${encodeURIComponent(videoId)}`, signal, ytAuthHeaders());
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
