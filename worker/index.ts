// Cloudflare Worker entry. The whole backend: pure JS, no binaries, no extra
// services. Serves the built SPA (env.ASSETS) and the /api/* routes, reusing the
// exact same resolver/search logic as the dev server.
//
//   /api/audio?v=   ANDROID_VR resolve + 1 MB chunked range stream (server/youtube)
//   /api/search?q=  youtubei.js search           (cf-worker build)
//   /api/playlist   youtubei.js playlist
//   /api/meta?v=    ANDROID_VR videoDetails
//
// The browser only ever talks to this Worker (same origin) and does all the
// heavy compute (decode / waveform / BPM / DSP). Nothing else runs anywhere.
import { Innertube } from "youtubei.js/cf-worker";
import { createInnertubeApi } from "../server/innertube";
import { audioChunks, fetchMeta, resolveAudio, type YtAuth } from "../server/youtube";

// User-supplied YouTube credentials, forwarded per request from their browser
// (never stored). Lets each user pass YouTube's "not a bot" challenge with their
// own session — see the in-app privacy notice.
function readAuth(req: Request): YtAuth | undefined {
  const cookie = req.headers.get("x-htl-yt-cookie") || undefined;
  const visitorData = req.headers.get("x-htl-yt-visitor") || undefined;
  const poToken = req.headers.get("x-htl-yt-potoken") || undefined;
  return cookie || visitorData || poToken ? { cookie, visitorData, poToken } : undefined;
}

interface R2ObjectBody {
  body: ReadableStream;
  size: number;
  httpMetadata?: { contentType?: string };
}
interface R2Bucket {
  get(key: string): Promise<R2ObjectBody | null>;
  head(key: string): Promise<{ size: number } | null>;
  put(key: string, value: ArrayBuffer | Uint8Array, opts?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
}

// 4-stem model (Demucs order). Stems are cached in R2 by videoId so they're
// separated ONCE (by a capable browser) and then DOWNLOADED by everyone else —
// phones never have to run the model.
const STEM_NAMES = ["vocals", "drums", "bass", "other"];
const MAX_STEM_BYTES = 40 * 1024 * 1024;
interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}
interface Env {
  ASSETS: { fetch(req: Request): Promise<Response> };
  AUDIO: R2Bucket;
}

// Don't buffer/cache absurdly large files (protect Worker memory) — stream those.
const MAX_CACHE_BYTES = 60 * 1024 * 1024;

const { searchYouTube, fetchPlaylist } = createInnertubeApi(Innertube as never);

// The SPA and the API are served by this same Worker, so every /api/* call is
// same-origin and needs no CORS. We deliberately do NOT send
// `access-control-allow-origin`, so the resolver can't be used as an open proxy
// by other sites. `no-store` keeps resolved audio out of intermediary caches.
const NO_CACHE = { "cache-control": "no-store" };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...NO_CACHE },
  });
}

const isVideoId = (v: string | null): v is string => !!v && /^[\w-]{11}$/.test(v);

async function handleApi(url: URL, req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { allow: "GET, PUT, OPTIONS" } });
  }
  try {
    switch (url.pathname) {
      case "/api/audio": {
        const v = url.searchParams.get("v");
        if (!isVideoId(v)) return json(400, { error: "missing or invalid ?v=" });
        const key = `a/${v}`;

        // Cache hit: serve from R2 — no YouTube request at all (no 403 risk, no
        // egress cost, fast). This is what keeps it on the free tier.
        const hit = await env.AUDIO.get(key);
        if (hit) {
          return new Response(hit.body, {
            headers: {
              "content-type": hit.httpMetadata?.contentType || "audio/mp4",
              "content-length": String(hit.size),
              "x-htl-cache": "hit",
              ...NO_CACHE,
            },
          });
        }

        const r = await resolveAudio(v, readAuth(req));

        // Oversized (long mixes): stream chunk-by-chunk, skip caching to protect
        // Worker memory.
        if (r.contentLength > MAX_CACHE_BYTES) {
          const stream = new ReadableStream<Uint8Array>({
            async start(controller) {
              try {
                for await (const chunk of audioChunks(r.url, r.contentLength)) controller.enqueue(chunk);
                controller.close();
              } catch (e) {
                controller.error(e);
              }
            },
          });
          const h: Record<string, string> = { "content-type": r.contentType, "x-htl-cache": "skip", ...NO_CACHE };
          if (r.contentLength) h["content-length"] = String(r.contentLength);
          return new Response(stream, { headers: h });
        }

        // Buffer the whole track, return to the user, and cache to R2 in the
        // background (waitUntil) so it doesn't delay playback.
        const parts: Uint8Array[] = [];
        let total = 0;
        for await (const chunk of audioChunks(r.url, r.contentLength)) {
          parts.push(chunk);
          total += chunk.byteLength;
        }
        const buf = new Uint8Array(total);
        let off = 0;
        for (const p of parts) {
          buf.set(p, off);
          off += p.byteLength;
        }
        ctx.waitUntil(env.AUDIO.put(key, buf, { httpMetadata: { contentType: r.contentType } }));
        return new Response(buf, {
          headers: {
            "content-type": r.contentType,
            "content-length": String(total),
            "x-htl-cache": "miss",
            ...NO_CACHE,
          },
        });
      }
      case "/api/search": {
        const q = url.searchParams.get("q")?.trim();
        if (!q) return json(400, { error: "missing ?q=" });
        const limit = Number(url.searchParams.get("limit")) || 25;
        return json(200, { results: await searchYouTube(q, limit) });
      }
      case "/api/playlist": {
        const raw = url.searchParams.get("list") ?? url.searchParams.get("url");
        if (!raw) return json(400, { error: "missing ?list=" });
        let listId = raw;
        if (/^https?:/.test(raw)) {
          try {
            listId = new URL(raw).searchParams.get("list") ?? raw;
          } catch {
            /* keep raw */
          }
        }
        return json(200, await fetchPlaylist(listId));
      }
      case "/api/meta": {
        const v = url.searchParams.get("v");
        if (!isVideoId(v)) return json(400, { error: "missing or invalid ?v=" });
        return json(200, await fetchMeta(v, readAuth(req)));
      }
      case "/api/stems": {
        // Shared stem cache. PUT?v=&s=<name> stores one separated stem; GET?v=&s=
        // returns it; GET?v= returns the manifest of stems already available.
        const v = url.searchParams.get("v");
        if (!isVideoId(v)) return json(400, { error: "missing or invalid ?v=" });
        const s = url.searchParams.get("s");

        if (req.method === "PUT") {
          if (!s || !STEM_NAMES.includes(s)) return json(400, { error: "missing or invalid ?s=" });
          const buf = await req.arrayBuffer();
          if (buf.byteLength === 0 || buf.byteLength > MAX_STEM_BYTES) return json(413, { error: "bad stem size" });
          await env.AUDIO.put(`s/${v}/${s}`, buf, {
            httpMetadata: { contentType: req.headers.get("content-type") || "audio/webm" },
          });
          return json(200, { ok: true });
        }

        if (s) {
          if (!STEM_NAMES.includes(s)) return json(400, { error: "invalid ?s=" });
          const hit = await env.AUDIO.get(`s/${v}/${s}`);
          if (!hit) return json(404, { error: "stem not cached" });
          return new Response(hit.body, {
            headers: {
              "content-type": hit.httpMetadata?.contentType || "audio/webm",
              "content-length": String(hit.size),
              "x-htl-cache": "hit",
              ...NO_CACHE,
            },
          });
        }

        const present: string[] = [];
        for (const name of STEM_NAMES) {
          if (await env.AUDIO.head(`s/${v}/${name}`)) present.push(name);
        }
        return json(200, { stems: present, complete: present.length === STEM_NAMES.length });
      }
      default:
        return json(404, { error: `unknown endpoint ${url.pathname}` });
    }
  } catch (e) {
    return json(502, { error: (e as Error).message });
  }
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/")) return handleApi(url, req, env, ctx);
    return env.ASSETS.fetch(req); // static SPA
  },
};
