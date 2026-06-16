import type { IncomingMessage, ServerResponse } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { Innertube } from "youtubei.js";
import { streamAudio } from "./audioProxy";
import { createInnertubeApi } from "./innertube";
import { recommendNext } from "./recommend";
import { featuresByIsrc, isrcForMbid } from "./features";
import { acoustidLookup } from "./acoustid";
import { oauthCreds, pollDeviceAuth, refreshAccessToken, startDeviceAuth } from "./oauth";
import { fetchCaptions, fetchMeta, type YtAuth } from "./youtube";
import {
  STEM_DOWNLOAD_CONTENT_TYPE,
  cleanText,
  foldHandle,
  looksLikeAudioStem,
  sanitizeHttpUrl,
  validateHandle,
} from "./security";
import * as devStore from "./devStore";

// The PUBLIC face of the dev user (mirrors publicIdentity() in server/accounts.ts).
function devPublicIdentity(u: devStore.DevUser) {
  return {
    handle: u.handle ?? null,
    displayName: u.display_name ?? u.name ?? null,
    avatar: u.avatar_url ?? u.avatar ?? null,
    bio: u.bio ?? null,
  };
}

// SECURITY: this Node handler is DEV-ONLY — it is mounted solely as Vite middleware
// (see vite.config.ts) and intentionally sends `Access-Control-Allow-Origin: *` for
// local convenience. It must NEVER be exposed publicly; production is the Cloudflare
// Worker (worker/index.ts), which is same-origin and sends no permissive CORS.

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
    // Parity with the Worker: only store recognized audio containers (no HTML/JS).
    if (!looksLikeAudioStem(body.subarray(0, 64))) return sendJson(res, 415, { error: "not a recognized audio stem" });
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(keyPath(s), body);
    return sendJson(res, 200, { ok: true });
  }

  if (s) {
    if (!STEM_NAMES.includes(s)) return sendJson(res, 400, { error: "invalid ?s=" });
    try {
      const buf = await fs.readFile(keyPath(s));
      res.statusCode = 200;
      // Fixed opaque type + nosniff + attachment (never render as a document).
      res.setHeader("Content-Type", STEM_DOWNLOAD_CONTENT_TYPE);
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Content-Disposition", "attachment");
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

const { searchYouTube, fetchPlaylist, getMyPlaylists, getWatchNext } = createInnertubeApi(Innertube as never);

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

// --- DEV-ONLY account emulation -------------------------------------------------------
// The production account layer (server/accounts.ts) needs D1 + Google OAuth + a session
// cookie, none of which exist in plain `vite` dev. To make sign-in / profile / settings
// sync / lyrics testable locally we fake them here, backed by server/devStore.ts. This is
// gated to non-production AND only ever mounted as Vite middleware (see the header note).
const DEV_AUTH = process.env.NODE_ENV !== "production";
const DEV_COOKIE = "htl_session";

function signedIn(req: IncomingMessage): boolean {
  const raw = req.headers.cookie ?? "";
  return raw.split(/;\s*/).some((c) => c === `${DEV_COOKIE}=dev`);
}

function sendRedirect(res: ServerResponse, location: string, setCookie?: string): void {
  res.statusCode = 302;
  res.setHeader("Location", location);
  if (setCookie) res.setHeader("Set-Cookie", setCookie);
  res.end();
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
    // PUBLIC profile by handle (dynamic path, matched before the exact switch).
    // Dev is single-user, so only the dev user's own handle resolves.
    if (DEV_AUTH && path.startsWith("/api/u/")) {
      const folded = foldHandle(decodeURIComponent(path.slice("/api/u/".length)));
      const u = await devStore.devUser();
      if (!u.handle || foldHandle(u.handle) !== folded) {
        sendJson(res, 404, { error: "no such handle" });
        return true;
      }
      const devLive = await devStore.roomLive();
      sendJson(res, 200, {
        handle: u.handle,
        // PUBLIC: never leak the Google legal name / avatar (B7) — see accounts.ts.
        displayName: u.display_name ?? null,
        avatar: u.avatar_url ?? null,
        bio: u.bio ?? null,
        memberSince: u.created_at,
        topTracks: await devStore.topTracks(12),
        // Dev is single-user, so the only resolvable handle is the dev user's own.
        counts: { followers: 0, following: 0 },
        live: devLive.live,
        liveListeners: devLive.listeners,
        isSelf: true,
        relationship: null,
      });
      return true;
    }
    // Graph actions + lists — dev is single-user, so following resolves to "that's
    // you" or "no such handle"; lists are always empty. (Full graph needs the Worker.)
    if (DEV_AUTH && (path === "/api/follow" || path === "/api/unfollow" || path === "/api/block" || path === "/api/unblock")) {
      if (!signedIn(req)) {
        sendJson(res, 401, { error: "sign in first" });
        return true;
      }
      const b = (await readJsonBody(req)) as { handle?: string };
      const u = await devUser();
      const same = u.handle && foldHandle(u.handle) === foldHandle(String(b.handle ?? ""));
      sendJson(res, same ? 400 : 404, { error: same ? "that's you" : "no such handle" });
      return true;
    }
    if (DEV_AUTH && (path === "/api/followers" || path === "/api/following")) {
      sendJson(res, 200, { list: [] });
      return true;
    }
    // Room directory (E2) + host announce/close (E1) — single dev room.
    if (DEV_AUTH && path === "/api/rooms/live") {
      sendJson(res, 200, { rooms: await devStore.liveRooms() });
      return true;
    }
    if (DEV_AUTH && (path === "/api/rooms/announce" || path === "/api/rooms/close")) {
      if (!signedIn(req)) {
        sendJson(res, 401, { error: "sign in first" });
        return true;
      }
      const u = await devStore.devUser();
      if (path === "/api/rooms/announce") {
        if (!u.handle) {
          sendJson(res, 400, { error: "claim a handle before going public" });
          return true;
        }
        const b = (await readJsonBody(req)) as {
          title?: string;
          genre?: string;
          listeners?: number;
          nowPlaying?: { title?: string; artist?: string };
        };
        await devStore.announceRoom({
          title: cleanText(b.title ?? "", 80) || null,
          genre: cleanText(b.genre ?? "", 32) || null,
          listeners: Math.max(0, Math.floor(Number(b.listeners) || 0)),
          npTitle: cleanText(b.nowPlaying?.title ?? "", 200) || null,
          npArtist: cleanText(b.nowPlaying?.artist ?? "", 120) || null,
        });
      } else {
        await devStore.closeRoom();
      }
      sendJson(res, 200, { ok: true });
      return true;
    }

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
      case "/api/recommend": {
        const v = url.searchParams.get("v");
        if (!v || !/^[\w-]{11}$/.test(v)) {
          sendJson(res, 400, { error: "missing or invalid ?v=" });
          return true;
        }
        const limit = Number(url.searchParams.get("limit")) || 30;
        const provider = url.searchParams.get("provider");
        const a = readAuth(req);
        const candidates = await recommendNext({ getWatchNext }, v, { provider, limit }, { cookie: a?.cookie, token: a?.accessToken });
        sendJson(res, 200, { candidates });
        return true;
      }
      case "/api/features": {
        const isrc = url.searchParams.get("isrc");
        if (!isrc) {
          sendJson(res, 400, { error: "missing ?isrc=" });
          return true;
        }
        sendJson(res, 200, { features: await featuresByIsrc(isrc) });
        return true;
      }
      case "/api/identify": {
        // Dev parity (no D1 cache): fingerprint → AcoustID → ISRC. Reads the key from
        // process.env (export ACOUSTID_API_KEY for `pnpm dev`); fail-soft otherwise.
        if (req.method !== "POST") {
          sendJson(res, 405, { error: "POST only" });
          return true;
        }
        const b = (await readJsonBody(req)) as { fingerprint?: string; duration?: number };
        const key = process.env.ACOUSTID_API_KEY;
        if (!key) {
          sendJson(res, 200, { identity: null, reason: "no_key" });
          return true;
        }
        if (!b.fingerprint || !b.duration) {
          sendJson(res, 400, { error: "missing fingerprint/duration" });
          return true;
        }
        const match = await acoustidLookup(key, b.fingerprint, b.duration);
        const isrc = match?.mbid ? await isrcForMbid(match.mbid) : null;
        sendJson(res, 200, { identity: match ? { isrc, mbid: match.mbid, artist: match.artist, title: match.title } : null });
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
        // No D1 in plain vite dev. GET → empty map (auto-mix falls back to provider
        // order); POST → accept + no-op so the client's contribution doesn't error.
        if (req.method === "GET") {
          sendJson(res, 200, { analysis: {} });
          return true;
        }
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
          stems: boolean; // the dev pool IS the stem cache, so these always have stems
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
              stems: true,
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
      // --- DEV account emulation (fake auth + file-backed stores) ---
      case "/api/auth/google/start": {
        if (!DEV_AUTH) break;
        // No real OAuth locally: drop a presence cookie and land back in the app, signed in
        // as the single dev user. Real Google sign-in is the `wrangler dev` path (see DEV.md).
        sendRedirect(res, "/", `${DEV_COOKIE}=dev; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}`);
        return true;
      }
      case "/api/auth/logout": {
        if (!DEV_AUTH) break;
        sendRedirect(res, "/", `${DEV_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
        return true;
      }
      case "/api/me": {
        if (!DEV_AUTH) break;
        if (!signedIn(req)) {
          sendJson(res, 200, { user: null, connections: [] });
          return true;
        }
        const u = await devStore.devUser();
        sendJson(res, 200, { user: { id: u.id, email: u.email, name: u.name, ...devPublicIdentity(u) }, connections: [] });
        return true;
      }
      case "/api/handle/check": {
        if (!DEV_AUTH) break;
        if (!signedIn(req)) {
          sendJson(res, 401, { error: "sign in first" });
          return true;
        }
        const v = validateHandle(url.searchParams.get("h"));
        if (!v.ok) {
          sendJson(res, 200, { available: false, reason: v.reason });
          return true;
        }
        const taken = await devStore.handleTaken(v.folded);
        sendJson(res, 200, { available: !taken, handle: v.handle, reason: taken ? "taken" : undefined });
        return true;
      }
      case "/api/me/handle": {
        if (!DEV_AUTH) break;
        if (req.method !== "POST") {
          sendJson(res, 405, { error: "POST only" });
          return true;
        }
        if (!signedIn(req)) {
          sendJson(res, 401, { error: "sign in first" });
          return true;
        }
        const b = (await readJsonBody(req)) as { handle?: string };
        const v = validateHandle(b.handle);
        if (!v.ok) {
          sendJson(res, 400, { error: v.reason });
          return true;
        }
        const u = await devStore.devUser();
        if (u.handle && foldHandle(u.handle) === v.folded) {
          sendJson(res, 200, { handle: u.handle });
          return true;
        }
        const claim = await devStore.setHandle(v.handle, v.folded);
        if (!claim.ok) {
          sendJson(res, 409, { error: claim.reason });
          return true;
        }
        sendJson(res, 200, { handle: v.handle });
        return true;
      }
      case "/api/me/profile": {
        if (!DEV_AUTH) break;
        if (!signedIn(req)) {
          sendJson(res, 401, { error: "sign in first" });
          return true;
        }
        if (req.method === "PUT") {
          const b = (await readJsonBody(req)) as { displayName?: string; bio?: string; avatarUrl?: string | null };
          const patch: { display_name?: string | null; bio?: string | null; avatar_url?: string | null } = {};
          if (b.displayName !== undefined) patch.display_name = cleanText(b.displayName, 48) || null;
          if (b.bio !== undefined) patch.bio = cleanText(b.bio, 300) || null;
          if (b.avatarUrl !== undefined) patch.avatar_url = b.avatarUrl === null ? null : sanitizeHttpUrl(b.avatarUrl);
          await devStore.updateProfile(patch);
          sendJson(res, 200, { ok: true, ...patch });
          return true;
        }
        const u = await devStore.devUser();
        sendJson(res, 200, {
          user: { id: u.id, email: u.email, name: u.name, memberSince: u.created_at, ...devPublicIdentity(u) },
          connections: [],
          topTracks: await devStore.topTracks(12),
        });
        return true;
      }
      case "/api/me/play": {
        if (!DEV_AUTH) break;
        if (req.method !== "POST") {
          sendJson(res, 405, { error: "POST only" });
          return true;
        }
        if (!signedIn(req)) {
          sendJson(res, 401, { error: "sign in first" });
          return true;
        }
        const b = (await readJsonBody(req)) as { videoId?: string; title?: string; artist?: string; thumbnail?: string };
        if (!b.videoId || !/^[\w-]{11}$/.test(b.videoId)) {
          sendJson(res, 400, { error: "bad videoId" });
          return true;
        }
        await devStore.logPlay({ videoId: b.videoId, title: b.title, artist: b.artist, thumbnail: b.thumbnail });
        sendJson(res, 200, { ok: true });
        return true;
      }
      case "/api/me/settings": {
        if (!DEV_AUTH) break;
        if (!signedIn(req)) {
          sendJson(res, 401, { error: "sign in first" });
          return true;
        }
        if (req.method === "GET") {
          const row = await devStore.getSettings();
          sendJson(res, 200, { data: row?.data ?? null, updatedAt: row?.updated_at ?? 0 });
          return true;
        }
        if (req.method === "PUT") {
          const body = (await readJsonBody(req)) as { data?: unknown; updatedAt?: number };
          if (body.data == null) {
            sendJson(res, 400, { error: "data required" });
            return true;
          }
          if (JSON.stringify(body.data).length > 256 * 1024) {
            sendJson(res, 413, { error: "settings too large" });
            return true;
          }
          const ts = typeof body.updatedAt === "number" ? body.updatedAt : Date.now();
          await devStore.putSettings(body.data, ts);
          sendJson(res, 200, { ok: true, updatedAt: ts });
          return true;
        }
        sendJson(res, 405, { error: "GET or PUT only" });
        return true;
      }
      case "/api/lyrics": {
        if (!DEV_AUTH) break;
        const v = url.searchParams.get("v");
        if (req.method === "GET") {
          if (!v || !/^[\w-]{11}$/.test(v)) {
            sendJson(res, 400, { error: "missing or invalid ?v=" });
            return true;
          }
          const row = await devStore.getLyrics(v);
          sendJson(res, 200, {
            transcript: row
              ? { v: 1, videoId: v, model: row.model, lang: row.lang, source: "pool", conf: row.conf, lines: row.lines, createdAt: 0 }
              : null,
          });
          return true;
        }
        if (req.method === "POST") {
          const b = (await readJsonBody(req)) as { videoId?: string; model?: string; lang?: string; conf?: number; lines?: unknown };
          if (!b.videoId || !/^[\w-]{11}$/.test(b.videoId) || !Array.isArray(b.lines) || !b.lines.length) {
            sendJson(res, 400, { error: "bad payload" });
            return true;
          }
          await devStore.putLyrics(b.videoId, {
            model: b.model === "small" ? "small" : "base",
            lang: typeof b.lang === "string" ? b.lang : "en",
            conf: typeof b.conf === "number" ? b.conf : 0,
            lines: b.lines,
          });
          sendJson(res, 200, { ok: true });
          return true;
        }
        sendJson(res, 405, { error: "GET or POST only" });
        return true;
      }

      default:
        sendJson(res, 404, { error: `unknown endpoint ${path}` });
        return true;
    }
    sendJson(res, 404, { error: `unknown endpoint ${path}` });
    return true;
  } catch (e) {
    sendJson(res, 502, { error: (e as Error).message });
    return true;
  }
}
