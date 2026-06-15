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

// Hard global cap: anything longer than this is a mix/compilation/livestream, never a
// mixable track. Enforced at the PARSER level so it's filtered out of EVERY list
// (search, watch-next, recommendations) — duration-based, since titles are unreliable
// ("… (1080p) || HD"). 0 = unknown duration, which we keep (the client load guard
// catches any that slip through).
export const MAX_TRACK_SECONDS = 15 * 60;

function tooLong(durationSec: number): boolean {
  return durationSec > MAX_TRACK_SECONDS;
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
  const duration = n.duration?.seconds ?? parseDuration(n.duration?.text);
  if (tooLong(duration)) return null;
  return {
    videoId: n.id,
    title: n.title?.text ?? n.id,
    artist: n.author?.name ?? "",
    duration,
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
  // Raw endpoint executor — the same Actions API in both youtubei.js builds. We
  // use it to hit `/next` (watch-next) directly and parse the raw JSON ourselves,
  // sidestepping the broken player/getInfo path (see header note).
  actions?: { execute(endpoint: string, args?: Record<string, unknown>): Promise<{ data?: unknown }> };
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
  ownerName?: string | null; // display name of the playlist owner (Spotify)
  ownedByMe?: boolean; // false = followed / shared-with-me (may not be API-readable)
}

export interface InnertubeApi {
  searchYouTube(query: string, limit?: number): Promise<TrackMeta[]>;
  // auth is optional — supply it to reach the user's PRIVATE playlists.
  fetchPlaylist(listId: string, auth?: BrowseAuth): Promise<{ title: string; tracks: TrackMeta[] }>;
  // The signed-in user's own playlists (requires a cookie, or an OAuth token).
  getMyPlaylists(auth: BrowseAuth): Promise<MyPlaylist[]>;
  // YouTube watch-next / autoplay graph for a video — the universal "what plays
  // after this" feed. auth is optional (personalizes the feed when present).
  getWatchNext(videoId: string, auth?: BrowseAuth): Promise<TrackMeta[]>;
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

// --- Watch-next parsing -------------------------------------------------------
// The `/next` response embeds the up-next/autoplay set as `compactVideoRenderer`
// nodes scattered through the layout (secondaryResults, autoplay, continuations).
// Rather than chase the exact path (which shifts by client/version), we walk the
// raw JSON and collect every compactVideoRenderer — robust across shapes.

function runsText(runs: unknown): string | undefined {
  if (!Array.isArray(runs)) return undefined;
  const s = runs.map((r) => (r as { text?: string }).text ?? "").join("");
  return s || undefined;
}

interface CompactRenderer {
  videoId?: string;
  title?: { simpleText?: string; runs?: unknown };
  lengthText?: { simpleText?: string; runs?: unknown };
  longBylineText?: { runs?: unknown };
  shortBylineText?: { runs?: unknown };
  viewCountText?: { simpleText?: string; runs?: unknown };
  shortViewCountText?: { simpleText?: string };
  thumbnail?: { thumbnails?: { url: string }[] };
}

function fromCompact(r: CompactRenderer): TrackMeta | null {
  const id = r.videoId;
  if (!id || !/^[\w-]{11}$/.test(id)) return null;
  const duration = parseDuration(r.lengthText?.simpleText ?? runsText(r.lengthText?.runs));
  if (tooLong(duration)) return null;
  const thumbs = r.thumbnail?.thumbnails;
  return {
    videoId: id,
    title: r.title?.simpleText ?? runsText(r.title?.runs) ?? id,
    artist: runsText(r.longBylineText?.runs) ?? runsText(r.shortBylineText?.runs) ?? "",
    duration,
    thumbnail:
      thumbs && thumbs.length ? thumbs[thumbs.length - 1].url : `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    views: parseViews(r.viewCountText?.simpleText ?? runsText(r.viewCountText?.runs) ?? r.shortViewCountText?.simpleText),
  };
}

// YouTube migrated watch-next to the new component system: related videos now arrive
// as `lockupViewModel` (the old `compactVideoRenderer` is gone on the WEB client). We
// parse both so the feed keeps working across the rollout.
interface LockupVM {
  contentId?: string;
  contentType?: string;
  metadata?: {
    lockupMetadataViewModel?: {
      title?: { content?: string };
      metadata?: { contentMetadataViewModel?: { metadataRows?: { metadataParts?: { text?: { content?: string } }[] }[] } };
    };
  };
  contentImage?: {
    thumbnailViewModel?: { overlays?: { thumbnailBottomOverlayViewModel?: { badges?: { thumbnailBadgeViewModel?: { text?: string } }[] } }[] };
  };
}

// YouTube's own "this is music" tag (Content-ID derived): a thumbnail badge with a
// MUSIC icon. It cleanly separates real tracks from non-music slop (gameplay,
// reactions, podcasts, "try not to laugh") in the watch-next feed — no title regex.
function lockupIsMusic(node: unknown, depth = 0): boolean {
  if (!node || depth > 25) return false;
  if (Array.isArray(node)) return node.some((x) => lockupIsMusic(x, depth + 1));
  if (typeof node !== "object") return false;
  const obj = node as Record<string, unknown>;
  if (obj.imageName === "MUSIC") return true;
  for (const k in obj) if (lockupIsMusic(obj[k], depth + 1)) return true;
  return false;
}

function fromLockup(l: LockupVM): TrackMeta | null {
  const id = l.contentId;
  if (!id || !/^[\w-]{11}$/.test(id)) return null; // 11-char = a video (skips playlist/channel lockups)
  if (l.contentType && l.contentType !== "LOCKUP_CONTENT_TYPE_VIDEO") return null;
  if (!lockupIsMusic(l)) return null; // reject non-music (YouTube's own MUSIC tag)
  const meta = l.metadata?.lockupMetadataViewModel;
  const title = meta?.title?.content;
  if (!title) return null; // skip placeholders / the current-video echo (no real title)
  // First metadata row's first part is the channel/artist (best-effort).
  const artist = meta?.metadata?.contentMetadataViewModel?.metadataRows?.[0]?.metadataParts?.[0]?.text?.content ?? "";
  // Duration sits in a thumbnail badge ("3:42").
  let durText: string | undefined;
  for (const o of l.contentImage?.thumbnailViewModel?.overlays ?? []) {
    for (const b of o.thumbnailBottomOverlayViewModel?.badges ?? []) {
      const t = b.thumbnailBadgeViewModel?.text;
      if (t && /^\d+(:\d+)+$/.test(t)) durText = t;
    }
  }
  const duration = parseDuration(durText);
  if (tooLong(duration)) return null; // drop hour-long mixes / livestreams
  return {
    videoId: id,
    title,
    artist,
    duration,
    thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    views: null,
  };
}

function collectVideos(node: unknown, push: (t: TrackMeta) => void, depth = 0): void {
  if (!node || depth > 40) return;
  if (Array.isArray(node)) {
    for (const x of node) collectVideos(x, push, depth + 1);
    return;
  }
  if (typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  if (obj.compactVideoRenderer) {
    const t = fromCompact(obj.compactVideoRenderer as CompactRenderer);
    if (t) push(t);
  }
  if (obj.lockupViewModel) {
    const t = fromLockup(obj.lockupViewModel as LockupVM);
    if (t) push(t);
  }
  for (const k in obj) {
    if (k === "compactVideoRenderer" || k === "lockupViewModel") continue;
    collectVideos(obj[k], push, depth + 1);
  }
}

/** Build the search/playlist API from an Innertube class (Node or cf-worker). */
export function createInnertubeApi(Innertube: InnertubeLike): InnertubeApi {
  // retrieve_player:false => never downloads/parses base.js (the broken bit).
  let ytPromise: ReturnType<InnertubeLike["create"]> | null = null;
  const client = () => (ytPromise ??= Innertube.create({ retrieve_player: false }));

  // YouTube's anti-bot intermittently 403s the anonymous WEB innertube endpoints (search,
  // watch-next) when our request egresses from a flagged Cloudflare datacenter IP / a
  // flagged client session. It's flaky (~1 in 12), and the cached singleton keeps a
  // poisoned session around, so: on failure drop the singleton and retry with a BRAND-NEW
  // client — fresh visitorData and often a different egress path — which clears it almost
  // every time. Only for the anonymous path; cookie-authed calls build a fresh client each
  // request and are rarely blocked.
  async function withRetry<T>(run: (yt: InnertubeInstance) => Promise<T>): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const yt = (await (attempt === 0 ? client() : Innertube.create({ retrieve_player: false }))) as InnertubeInstance;
        return await run(yt);
      } catch (e) {
        lastErr = e;
        ytPromise = null; // discard the flagged session; next call rebuilds fresh
        await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
      }
    }
    throw lastErr;
  }

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
      const res = await withRetry((yt) => yt.search(query, { type: "video" }));
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
    async getWatchNext(videoId, auth) {
      // Cookie personalizes the feed (recently-played aware); otherwise anonymous (and
      // retried through fresh clients, since the anon path catches the same 403 flakiness).
      const exec = async (yt: InnertubeInstance): Promise<unknown> => {
        if (!yt.actions?.execute) throw new Error("watch-next unavailable in this youtubei build");
        const res = await yt.actions.execute("/next", { videoId, parse: false });
        return res?.data ?? res;
      };
      let data: unknown;
      try {
        data = auth?.cookie ? await exec(await cookieClient(auth.cookie)) : await withRetry(exec);
      } catch (e) {
        throw new Error(`watch-next failed: ${(e as Error).message}`);
      }
      const out: TrackMeta[] = [];
      const seen = new Set<string>([videoId]); // never suggest the seed itself
      collectVideos(data, (t) => {
        if (seen.has(t.videoId)) return;
        seen.add(t.videoId);
        out.push(t);
      });
      return out;
    },
  };
}
