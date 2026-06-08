import type { IncomingMessage, ServerResponse } from "node:http";
import { Innertube } from "youtubei.js";
import { streamAudio } from "./audioProxy";
import { createInnertubeApi } from "./innertube";
import { fetchMeta } from "./youtube";

const { searchYouTube, fetchPlaylist } = createInnertubeApi(Innertube as never);

// Single entry point for every /api/* route, shared by the Vite dev middleware
// and the production serverless handlers. Returns true if it handled the
// request, false if the path isn't ours (so the dev server can fall through).

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.end(payload);
}


export async function handleApi(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? "", "http://localhost");
  const path = url.pathname;
  if (!path.startsWith("/api/")) return false;

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.end();
    return true;
  }

  try {
    switch (path) {
      case "/api/audio": {
        const v = url.searchParams.get("v");
        if (!v || !/^[\w-]{11}$/.test(v)) {
          sendJson(res, 400, { error: "missing or invalid ?v=" });
          return true;
        }
        await streamAudio(req, res, v);
        return true;
      }
      case "/api/search": {
        const q = url.searchParams.get("q")?.trim();
        if (!q) {
          sendJson(res, 400, { error: "missing ?q=" });
          return true;
        }
        const limit = Number(url.searchParams.get("limit")) || 25;
        sendJson(res, 200, { results: await searchYouTube(q, limit) });
        return true;
      }
      case "/api/playlist": {
        const raw = url.searchParams.get("list") ?? url.searchParams.get("url");
        if (!raw) {
          sendJson(res, 400, { error: "missing ?list= or ?url=" });
          return true;
        }
        // Accept a bare list id or any URL containing ?list=.
        let listId = raw;
        if (/^https?:/.test(raw)) {
          try {
            listId = new URL(raw).searchParams.get("list") ?? raw;
          } catch {
            /* keep raw */
          }
        }
        sendJson(res, 200, await fetchPlaylist(listId));
        return true;
      }
      case "/api/meta": {
        const v = url.searchParams.get("v");
        if (!v || !/^[\w-]{11}$/.test(v)) {
          sendJson(res, 400, { error: "missing or invalid ?v=" });
          return true;
        }
        sendJson(res, 200, await fetchMeta(v));
        return true;
      }
      default:
        sendJson(res, 404, { error: `unknown endpoint ${path}` });
        return true;
    }
  } catch (e) {
    sendJson(res, 502, { error: (e as Error).message });
    return true;
  }
}
