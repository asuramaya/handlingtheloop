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
import { audioChunks, fetchMeta, resolveAudio } from "../server/youtube";

interface R2ObjectBody {
  body: ReadableStream;
  size: number;
  httpMetadata?: { contentType?: string };
}
interface R2Bucket {
  get(key: string): Promise<R2ObjectBody | null>;
  put(key: string, value: ArrayBuffer | Uint8Array, opts?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
}
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

const CORS = { "access-control-allow-origin": "*", "cache-control": "no-store" };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CORS },
  });
}

const isVideoId = (v: string | null): v is string => !!v && /^[\w-]{11}$/.test(v);

async function handleApi(url: URL, req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, OPTIONS" },
    });
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
              ...CORS,
            },
          });
        }

        const r = await resolveAudio(v);

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
          const h: Record<string, string> = { "content-type": r.contentType, "x-htl-cache": "skip", ...CORS };
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
            ...CORS,
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
        return json(200, await fetchMeta(v));
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
