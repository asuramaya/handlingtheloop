import type { TrackMeta } from "./youtube";
import { fetchPlaylistData, getMyPlaylistsData } from "./ytdata";

// Search + playlist via youtubei.js. We never touch its player/extraction path
// (that's broken against current YouTube and handled by our own ANDROID_VR
// resolver in youtube.ts); only the browse/search endpoints, which are stable.
//
// This is a factory that takes the Innertube class so the same logic runs with
// the Node build ("youtubei.js", dev server) and the Worker build
// ("youtubei.js/cf-worker", worker/index.ts).

interface AnyNode {
  id?: string;
  title?: { text?: string };
  author?: { name?: string };
  duration?: { seconds?: number; text?: string };
  thumbnails?: { url: string }[];
  view_count?: { text?: string };
  short_view_count?: { text?: string };
}

function parseDuration(text?: string): number {
  if (!text) return 0;
  const parts = text.split(":").map(Number);
  if (parts.some((n) => Number.isNaN(n))) return 0;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

function parseViews(text?: string): number | null {
  if (!text) return null;
  const m = text.replace(/,/g, "").match(/([\d.]+)\s*([KMB])?/i);
  if (!m) return null;
  const mult = { K: 1e3, M: 1e6, B: 1e9 }[(m[2] || "").toUpperCase()] ?? 1;
  return Math.round(Number(m[1]) * mult);
}

function normalize(n: AnyNode): TrackMeta | null {
  if (!n.id || !/^[\w-]{11}$/.test(n.id)) return null;
  return {
    videoId: n.id,
    title: n.title?.text ?? n.id,
    artist: n.author?.name ?? "",
    duration: n.duration?.seconds ?? parseDuration(n.duration?.text),
    thumbnail:
      n.thumbnails && n.thumbnails.length
        ? n.thumbnails[n.thumbnails.length - 1].url
        : `https://i.ytimg.com/vi/${n.id}/hqdefault.jpg`,
    views: parseViews(n.view_count?.text ?? n.short_view_count?.text),
  };
}

// A cookie-authenticated Innertube instance exposes the account browse endpoints.
// Typed loosely — youtubei.js's node shapes vary by version and we read them
// defensively (textOf/numOf below).
interface InnertubeInstance {
  search(q: string, opts: { type: string }): Promise<{ results?: unknown[] }>;
  getPlaylist(id: string): Promise<{ info?: { title?: string }; videos?: unknown[] }>;
  getPlaylists?(): Promise<{ playlists?: unknown[] }>;
}
interface InnertubeLike {
  // `cookie` authenticates the WEB client natively (youtubei.js computes the
  // SAPISIDHASH itself) — the reliable way to reach a user's own browse data.
  create(opts: { retrieve_player: boolean; cookie?: string }): Promise<InnertubeInstance>;
}

/**
 * Credentials for an authenticated browse (a user's own/private data). The two
 * are read by DIFFERENT backends because they authenticate different clients:
 *   - `cookie` (SAPISID) → youtubei.js, which signs the WEB client with its
 *     SAPISIDHASH so browse/getPlaylists work.
 *   - `token` (Google sign-in) → the YouTube Data API v3 (see ytdata.ts); a
 *     TV-device token can't authenticate youtubei.js's WEB browse (it 400/401s),
 *     but the Data API accepts any validly-scoped Bearer.
 * Cookie wins when both are present.
 */
export interface BrowseAuth {
  cookie?: string;
  token?: string;
}

/** A YouTube playlist the signed-in user owns/follows (from `getPlaylists`). */
export interface MyPlaylist {
  id: string;
  title: string;
  count: number;
  thumbnail: string | null;
}

export interface InnertubeApi {
  searchYouTube(query: string, limit?: number): Promise<TrackMeta[]>;
  // auth is optional — supply it to reach the user's PRIVATE playlists.
  fetchPlaylist(listId: string, auth?: BrowseAuth): Promise<{ title: string; tracks: TrackMeta[] }>;
  // The signed-in user's own playlists (requires a cookie, or an OAuth token).
  getMyPlaylists(auth: BrowseAuth): Promise<MyPlaylist[]>;
}

// youtubei.js wraps strings in Text nodes (`{ text }`) and counts in Text too —
// read both shapes (and bare strings) safely.
function textOf(v: unknown): string {
  if (!v) return "";
  if (typeof v === "string") return v;
  const o = v as { text?: string; toString?: () => string };
  if (typeof o.text === "string") return o.text;
  return typeof o.toString === "function" ? o.toString() : "";
}
function numOf(v: unknown): number {
  const s = textOf(v).replace(/[^\d]/g, "");
  return s ? parseInt(s, 10) : 0;
}

/** Build the search/playlist API from an Innertube class (Node or cf-worker). */
export function createInnertubeApi(Innertube: InnertubeLike): InnertubeApi {
  // retrieve_player:false => never downloads/parses base.js (the broken bit).
  let ytPromise: ReturnType<InnertubeLike["create"]> | null = null;
  const client = () => (ytPromise ??= Innertube.create({ retrieve_player: false }));

  // A fresh, cookie-authenticated client per request. youtubei.js authenticates
  // the WEB client with the cookie's SAPISIDHASH, so browse/getPlaylists work and
  // parse cleanly. (OAuth tokens go through the Data API instead — see ytdata.ts.)
  async function cookieClient(cookie: string): Promise<InnertubeInstance> {
    try {
      return await Innertube.create({ retrieve_player: false, cookie });
    } catch (e) {
      throw new Error(`cookie signin failed: ${(e as Error).message}`);
    }
  }

  async function readPlaylist(yt: InnertubeInstance, listId: string) {
    const pl = await yt.getPlaylist(listId);
    const tracks: TrackMeta[] = [];
    for (const v of pl.videos ?? []) {
      const t = normalize(v as AnyNode);
      if (t) tracks.push(t);
    }
    return { title: pl.info?.title ?? "Playlist", tracks };
  }

  return {
    async searchYouTube(query, limit = 25) {
      const yt = await client();
      const res = await yt.search(query, { type: "video" });
      const out: TrackMeta[] = [];
      for (const r of res.results ?? []) {
        if ((r as { type?: string }).type !== "Video") continue;
        const t = normalize(r as AnyNode);
        if (t) out.push(t);
        if (out.length >= limit) break;
      }
      return out;
    },
    async fetchPlaylist(listId, auth) {
      // Cookie → youtubei.js; OAuth token → Data API; neither → public youtubei.js.
      if (auth?.cookie) return readPlaylist(await cookieClient(auth.cookie), listId);
      if (auth?.token) return fetchPlaylistData(auth.token, listId);
      return readPlaylist(await client(), listId);
    },
    async getMyPlaylists(auth) {
      // OAuth token → the official Data API (a TV token can't drive youtubei browse).
      if (!auth.cookie && auth.token) return getMyPlaylistsData(auth.token);
      if (!auth.cookie) throw new Error("connect YouTube first");
      const yt = await cookieClient(auth.cookie);
      if (!yt.getPlaylists) throw new Error("getPlaylists unavailable in this youtubei build");
      let feed: { playlists?: unknown[] };
      try {
        feed = await yt.getPlaylists();
      } catch (e) {
        throw new Error(`browse failed: ${(e as Error).message}`);
      }
      const raw = feed.playlists ?? [];
      const out: MyPlaylist[] = [];
      for (const p of raw) {
        const node = p as { id?: string; title?: unknown; video_count?: unknown; thumbnails?: { url: string }[] };
        if (!node.id) continue;
        const thumbs = node.thumbnails;
        out.push({
          id: node.id,
          title: textOf(node.title) || "Playlist",
          count: numOf(node.video_count),
          thumbnail: thumbs && thumbs.length ? thumbs[thumbs.length - 1].url : null,
        });
      }
      // Surface a parse gap (browse returned items we couldn't read) vs a genuinely
      // empty account, so the UI error is actionable.
      if (out.length === 0 && raw.length > 0) {
        throw new Error(`browse returned ${raw.length} items but none parsed as playlists`);
      }
      return out;
    },
  };
}
