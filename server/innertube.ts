import type { TrackMeta } from "./youtube";

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

interface InnertubeLike {
  create(opts: { retrieve_player: boolean }): Promise<{
    search(q: string, opts: { type: string }): Promise<{ results?: unknown[] }>;
    getPlaylist(id: string): Promise<{ info?: { title?: string }; videos?: unknown[] }>;
  }>;
}

export interface InnertubeApi {
  searchYouTube(query: string, limit?: number): Promise<TrackMeta[]>;
  fetchPlaylist(listId: string): Promise<{ title: string; tracks: TrackMeta[] }>;
}

/** Build the search/playlist API from an Innertube class (Node or cf-worker). */
export function createInnertubeApi(Innertube: InnertubeLike): InnertubeApi {
  // retrieve_player:false => never downloads/parses base.js (the broken bit).
  let ytPromise: ReturnType<InnertubeLike["create"]> | null = null;
  const client = () => (ytPromise ??= Innertube.create({ retrieve_player: false }));

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
    async fetchPlaylist(listId) {
      const yt = await client();
      const pl = await yt.getPlaylist(listId);
      const tracks: TrackMeta[] = [];
      for (const v of pl.videos ?? []) {
        const t = normalize(v as AnyNode);
        if (t) tracks.push(t);
      }
      return { title: pl.info?.title ?? "Playlist", tracks };
    },
  };
}
