// YouTube Data API v3 browse, authenticated by an OAuth 2.0 Bearer token.
//
// WHY THIS EXISTS (and isn't innertube)
//   Our Google sign-in is a "TV and Limited-Input Device" flow, so the access
//   token authenticates the TV client only. youtubei.js's browse uses the WEB
//   client, which REJECTS a TV token (HTTP 400/401) — the same client mismatch
//   that bars the token from the player. The official Data API, by contrast,
//   accepts any validly-scoped OAuth Bearer (our scope includes
//   https://www.googleapis.com/auth/youtube), so it's the reliable way to read a
//   signed-in user's own playlists. Pure-JS fetch; runs in Worker and Node alike.
//
// A cookie-authenticated user goes through innertube instead (see innertube.ts);
// this path is exclusively for the OAuth (Google sign-in) credential.
import type { MyPlaylist } from "./innertube";
import type { TrackMeta } from "./youtube";

const API = "https://www.googleapis.com/youtube/v3";
const TIMEOUT_MS = 8000;
const MAX_ITEM_PAGES = 4; // cap a playlist import at ~200 items (quota + wall-clock)

// Data API thumbnail set; pick the largest present.
interface Thumbs {
  default?: { url: string };
  medium?: { url: string };
  high?: { url: string };
  standard?: { url: string };
  maxres?: { url: string };
}
function bestThumb(t?: Thumbs): string | null {
  return t?.maxres?.url ?? t?.standard?.url ?? t?.high?.url ?? t?.medium?.url ?? t?.default?.url ?? null;
}

// GET a Data API resource with the Bearer token. No API key needed — OAuth
// identifies the caller. Throws a readable error on a non-2xx.
async function get(path: string, token: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${API}/${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const err = j.error as { message?: string; errors?: { reason?: string }[] } | undefined;
    const reason = err?.errors?.[0]?.reason;
    throw new Error(`data ${res.status}${err?.message ? `: ${err.message}` : ""}${reason ? ` (${reason})` : ""}`);
  }
  return j;
}

// POST a Data API resource (writes: create playlist, add item). `parts` go in the
// query string; `body` is the resource. Throws a readable error on non-2xx.
async function post(resource: string, parts: string, token: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${API}/${resource}?part=${parts}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const err = j.error as { message?: string; errors?: { reason?: string }[] } | undefined;
    const reason = err?.errors?.[0]?.reason;
    throw new Error(`data ${res.status}${err?.message ? `: ${err.message}` : ""}${reason ? ` (${reason})` : ""}`);
  }
  return j;
}

/** Create a private playlist, returning its id. */
export async function createYouTubePlaylist(token: string, title: string, description = ""): Promise<string> {
  const j = await post("playlists", "snippet,status", token, {
    snippet: { title, description },
    status: { privacyStatus: "private" },
  });
  const id = (j as { id?: string }).id;
  if (!id) throw new Error("playlist create returned no id");
  return id;
}

/** Append a video to a playlist. */
export async function addToYouTubePlaylist(token: string, playlistId: string, videoId: string): Promise<void> {
  await post("playlistItems", "snippet", token, {
    snippet: { playlistId, resourceId: { kind: "youtube#video", videoId } },
  });
}

// ISO-8601 duration (e.g. "PT4M13S", "PT1H2M") -> seconds.
function parseISODuration(iso?: string): number {
  if (!iso) return 0;
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  return (Number(m[1]) || 0) * 3600 + (Number(m[2]) || 0) * 60 + (Number(m[3]) || 0);
}

interface PlaylistsItem {
  id: string;
  snippet?: { title?: string; thumbnails?: Thumbs };
  contentDetails?: { itemCount?: number };
}

/** The signed-in user's own playlists (public + private), via OAuth. */
export async function getMyPlaylistsData(token: string): Promise<MyPlaylist[]> {
  const out: MyPlaylist[] = [];
  let pageToken = "";
  do {
    const q = `playlists?part=snippet,contentDetails&mine=true&maxResults=50${pageToken ? `&pageToken=${pageToken}` : ""}`;
    const j = await get(q, token);
    for (const it of (j.items as PlaylistsItem[]) ?? []) {
      if (!it.id) continue;
      out.push({
        id: it.id,
        title: it.snippet?.title || "Playlist",
        count: it.contentDetails?.itemCount ?? 0,
        thumbnail: bestThumb(it.snippet?.thumbnails),
      });
    }
    pageToken = (j.nextPageToken as string) || "";
  } while (pageToken);
  return out;
}

interface ItemsItem {
  snippet?: { title?: string; videoOwnerChannelTitle?: string; thumbnails?: Thumbs; resourceId?: { videoId?: string } };
}
interface VideosItem {
  id: string;
  snippet?: { title?: string; channelTitle?: string; thumbnails?: Thumbs };
  contentDetails?: { duration?: string };
  statistics?: { viewCount?: string };
}

/** A playlist's tracks (the user's own/private included), via OAuth. */
export async function fetchPlaylistData(token: string, playlistId: string): Promise<{ title: string; tracks: TrackMeta[] }> {
  // Title from the playlist resource (mine context covers private ones).
  let title = "Playlist";
  try {
    const pj = await get(`playlists?part=snippet&id=${encodeURIComponent(playlistId)}`, token);
    const p = ((pj.items as PlaylistsItem[]) ?? [])[0];
    if (p?.snippet?.title) title = p.snippet.title;
  } catch {
    /* non-fatal — fall back to a generic title */
  }

  // Ordered video ids (+ snippet) from playlistItems, bounded pages.
  const order: string[] = [];
  const snippetById = new Map<string, ItemsItem["snippet"]>();
  let pageToken = "";
  for (let page = 0; page < MAX_ITEM_PAGES; page++) {
    const q = `playlistItems?part=snippet&playlistId=${encodeURIComponent(playlistId)}&maxResults=50${pageToken ? `&pageToken=${pageToken}` : ""}`;
    const j = await get(q, token);
    for (const it of (j.items as ItemsItem[]) ?? []) {
      const vid = it.snippet?.resourceId?.videoId;
      if (vid && /^[\w-]{11}$/.test(vid) && !snippetById.has(vid)) {
        order.push(vid);
        snippetById.set(vid, it.snippet);
      }
    }
    pageToken = (j.nextPageToken as string) || "";
    if (!pageToken) break;
  }

  // Enrich with duration + views via videos.list (batched by 50).
  const details = new Map<string, VideosItem>();
  for (let i = 0; i < order.length; i += 50) {
    const ids = order.slice(i, i + 50).join(",");
    const j = await get(`videos?part=snippet,contentDetails,statistics&id=${ids}`, token);
    for (const v of (j.items as VideosItem[]) ?? []) details.set(v.id, v);
  }

  const tracks: TrackMeta[] = [];
  for (const vid of order) {
    const d = details.get(vid);
    const s = snippetById.get(vid);
    tracks.push({
      videoId: vid,
      title: d?.snippet?.title || s?.title || vid,
      artist: d?.snippet?.channelTitle || s?.videoOwnerChannelTitle || "",
      duration: parseISODuration(d?.contentDetails?.duration),
      thumbnail: bestThumb(d?.snippet?.thumbnails ?? s?.thumbnails) || `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`,
      views: d?.statistics?.viewCount ? Number(d.statistics.viewCount) || null : null,
    });
  }
  return { title, tracks };
}
