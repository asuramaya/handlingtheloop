import type { IncomingMessage, ServerResponse } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { Innertube } from "youtubei.js";
import { streamAudio } from "./audioProxy";
import { createInnertubeApi } from "./innertube";
import { oauthCreds, pollDeviceAuth, refreshAccessToken, startDeviceAuth } from "./oauth";
import { fetchCaptions, fetchMeta, type YtAuth } from "./youtube";

// Dev-only stem cache: stands in for the Worker's R2 so separated stems persist
// across reloads locally (keyed per model, like prod). Files land in .stem-cache/.
const STEM_NAMES = ["vocals", "drums", "bass", "other"];
const STEM_CACHE_DIR = path.resolve(".stem-cache");

function readRawBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function handleStems(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const v = url.searchParams.get("v");
  if (!v || !/^[\w-]{1,64}$/.test(v)) return sendJson(res, 400, { error: "missing or invalid ?v=" });
  const model = (url.searchParams.get("model") || "dsp").toLowerCase();
  if (!/^[a-z0-9-]{1,32}$/.test(model)) return sendJson(res, 400, { error: "invalid ?model=" });
  const s = url.searchParams.get("s");
  const dir = path.join(STEM_CACHE_DIR, model, v);
  const keyPath = (name: string) => path.join(dir, name);

  if (req.method === "PUT") {
    if (!s || !STEM_NAMES.includes(s)) return sendJson(res, 400, { error: "missing or invalid ?s=" });
    const body = await readRawBody(req);
    if (!body.length || body.length > 60_000_000) return sendJson(res, 413, { error: "bad stem size" });
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(keyPath(s), body);
    return sendJson(res, 200, { ok: true });
  }

  if (s) {
    if (!STEM_NAMES.includes(s)) return sendJson(res, 400, { error: "invalid ?s=" });
    try {
      const buf = await fs.readFile(keyPath(s));
      res.statusCode = 200;
      res.setHeader("Content-Type", "audio/webm");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("x-htl-cache", "hit");
      res.end(buf);
    } catch {
      sendJson(res, 404, { error: "stem not cached" });
    }
    return;
  }

  const present: string[] = [];
  for (const name of STEM_NAMES) {
    try {
      await fs.access(keyPath(name));
      present.push(name);
    } catch {
      /* not cached */
    }
  }
  sendJson(res, 200, { stems: present, complete: present.length === STEM_NAMES.length });
}

const { searchYouTube, fetchPlaylist, getMyPlaylists } = createInnertubeApi(Innertube as never);

function readAuth(req: IncomingMessage): YtAuth | undefined {
  const h = (n: string) => {
    const v = req.headers[n];
    return (Array.isArray(v) ? v[0] : v) || undefined;
  };
  const cookie = h("x-htl-yt-cookie");
  const visitorData = h("x-htl-yt-visitor");
  const poToken = h("x-htl-yt-potoken");
  const accessToken = h("x-htl-yt-token");
  return cookie || visitorData || poToken || accessToken
    ? { cookie, visitorData, poToken, accessToken }
    : undefined;
}

// Read a JSON request body (dev server only; the Worker has req.json()).
function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
}

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
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
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
        await streamAudio(req, res, v, readAuth(req));
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
        const a = readAuth(req);
        sendJson(res, 200, await fetchPlaylist(listId, { cookie: a?.cookie, token: a?.accessToken }));
        return true;
      }
      case "/api/me/playlists": {
        const a = readAuth(req);
        if (!a?.cookie && !a?.accessToken) {
          sendJson(res, 401, { error: "connect YouTube first" });
          return true;
        }
        sendJson(res, 200, { playlists: await getMyPlaylists({ cookie: a.cookie, token: a.accessToken }) });
        return true;
      }
      case "/api/analysis": {
        // No D1 in plain vite dev — accept and no-op so the client's best-effort
        // contribution doesn't error locally. (wrangler/prod stores it in D1.)
        sendJson(res, 200, { ok: true });
        return true;
      }
      case "/api/community/meta": {
        // Durable metadata backfill (dev): persist a sidecar JSON, mirroring the
        // worker's `m/<videoId>` R2 sidecar.
        const b = await readJsonBody(req);
        const v = String(b.videoId ?? "");
        if (!/^[\w-]{11}$/.test(v) || !b.title) {
          sendJson(res, 400, { error: "missing videoId or title" });
          return true;
        }
        await fs.mkdir(`${STEM_CACHE_DIR}/_meta`, { recursive: true });
        await fs.writeFile(
          `${STEM_CACHE_DIR}/_meta/${v}.json`,
          JSON.stringify({ title: b.title, artist: b.artist ?? "", duration: b.duration ?? 0, thumbnail: b.thumbnail ?? null }),
        );
        sendJson(res, 200, { ok: true });
        return true;
      }
      case "/api/community": {
        // No R2 in plain `vite` dev, but stems ARE cached on disk (.stem-cache) —
        // surface those videoIds so the Community section isn't empty locally.
        // Titles come from backfilled sidecars in .stem-cache/_meta (mirrors the
        // worker's `m/` sidecars); the client backfills any still missing.
        const seen = new Set<string>();
        const tracks: {
          videoId: string;
          title: string;
          artist: string;
          duration: number;
          thumbnail: string;
          views: null;
        }[] = [];
        const models = (await fs.readdir(STEM_CACHE_DIR).catch(() => [] as string[])).filter((d) => !d.startsWith("_"));
        for (const model of models) {
          const vids = await fs.readdir(`${STEM_CACHE_DIR}/${model}`).catch(() => [] as string[]);
          for (const v of vids) {
            if (seen.has(v) || !/^[\w-]{11}$/.test(v)) continue;
            seen.add(v);
            let m: { title?: string; artist?: string; duration?: number; thumbnail?: string } = {};
            try {
              m = JSON.parse(await fs.readFile(`${STEM_CACHE_DIR}/_meta/${v}.json`, "utf8"));
            } catch {
              /* no sidecar yet */
            }
            tracks.push({
              videoId: v,
              title: m.title ?? "",
              artist: m.artist ?? "",
              duration: m.duration ?? 0,
              thumbnail: m.thumbnail ?? `https://i.ytimg.com/vi/${v}/hqdefault.jpg`,
              views: null,
            });
          }
        }
        sendJson(res, 200, { tracks });
        return true;
      }
      case "/api/stems": {
        await handleStems(req, res, url);
        return true;
      }
      case "/api/meta": {
        const v = url.searchParams.get("v");
        if (!v || !/^[\w-]{11}$/.test(v)) {
          sendJson(res, 400, { error: "missing or invalid ?v=" });
          return true;
        }
        sendJson(res, 200, await fetchMeta(v, readAuth(req)));
        return true;
      }
      case "/api/captions": {
        const v = url.searchParams.get("v");
        if (!v || !/^[\w-]{11}$/.test(v)) {
          sendJson(res, 400, { error: "missing or invalid ?v=" });
          return true;
        }
        try {
          sendJson(res, 200, { cues: await fetchCaptions(v, readAuth(req)) });
        } catch {
          sendJson(res, 200, { cues: [] });
        }
        return true;
      }
      case "/api/auth/device": {
        sendJson(res, 200, await startDeviceAuth(oauthCreds(process.env)));
        return true;
      }
      case "/api/auth/poll": {
        const { device_code } = await readJsonBody(req);
        if (typeof device_code !== "string") {
          sendJson(res, 400, { error: "missing device_code" });
          return true;
        }
        sendJson(res, 200, await pollDeviceAuth(oauthCreds(process.env), device_code));
        return true;
      }
      case "/api/auth/refresh": {
        const { refresh_token } = await readJsonBody(req);
        if (typeof refresh_token !== "string") {
          sendJson(res, 400, { error: "missing refresh_token" });
          return true;
        }
        sendJson(res, 200, await refreshAccessToken(oauthCreds(process.env), refresh_token));
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
