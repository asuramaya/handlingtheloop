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
import { audioChunks, fetchCaptions, fetchMeta, resolveAudio, type TrackMeta, type YtAuth } from "../server/youtube";
import { oauthCreds, pollDeviceAuth, refreshAccessToken, startDeviceAuth } from "../server/oauth";
import { type AccountEnv, handleAccountRoute } from "../server/accounts";
import {
  type D1Database,
  userBySession,
  upsertCommunityTrack,
  listCommunityTracks,
  upsertAnalysis,
  getOrCreateInvite,
  inviteOwner,
  getCachedCaptions,
  putCachedCaptions,
} from "../server/db";
import { readSessionId } from "../server/session";
import {
  type RateLimiter,
  STEM_DOWNLOAD_CONTENT_TYPE,
  DOWNLOAD_SAFE_HEADERS,
  SECURITY_HEADERS,
  allow,
  clampNum,
  cleanText,
  clientIp,
  looksLikeAudioStem,
  sanitizeHttpUrl,
} from "../server/security";
import {
  type Service,
  type SourceTrack,
  addToDestPlaylist,
  createDestPlaylist,
  matchTracks,
  readSource,
  searchDest,
} from "../server/sync";

// User-supplied YouTube credentials, forwarded per request from their browser
// (never stored). Lets each user pass YouTube's "not a bot" challenge with their
// own session — an OAuth bearer (device-code sign-in) or a pasted cookie. See the
// in-app privacy notice.
function readAuth(req: Request): YtAuth | undefined {
  const cookie = req.headers.get("x-htl-yt-cookie") || undefined;
  const visitorData = req.headers.get("x-htl-yt-visitor") || undefined;
  const poToken = req.headers.get("x-htl-yt-potoken") || undefined;
  const accessToken = req.headers.get("x-htl-yt-token") || undefined;
  return cookie || visitorData || poToken || accessToken
    ? { cookie, visitorData, poToken, accessToken }
    : undefined;
}

interface R2ObjectBody {
  body: ReadableStream;
  size: number;
  httpMetadata?: { contentType?: string };
}
interface R2Object {
  key: string;
  size: number;
  customMetadata?: Record<string, string>;
}
interface R2Bucket {
  get(key: string): Promise<R2ObjectBody | null>;
  head(key: string): Promise<{ size: number } | null>;
  put(
    key: string,
    value: ArrayBuffer | Uint8Array,
    opts?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> },
  ): Promise<unknown>;
  list(opts?: {
    prefix?: string;
    limit?: number;
    cursor?: string;
    include?: ("customMetadata" | "httpMetadata")[];
  }): Promise<{ objects: R2Object[]; truncated: boolean; cursor?: string }>;
}

// 4-stem model (Demucs order). Stems are cached in R2 by videoId so they're
// separated ONCE (by a capable browser) and then DOWNLOADED by everyone else —
// phones never have to run the model.
const STEM_NAMES = ["vocals", "drums", "bass", "other"];
// Stems are cached as 16-bit WAV (~11 MB/min stereo), so a typical 4–7 min track
// is ~45–80 MB/stem. 160 MB covers ~12 min; longer stems just skip the cache.
const MAX_STEM_BYTES = 160 * 1024 * 1024;
interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}
// Durable Object binding for the shared-session rooms (server/room.ts).
interface DurableObjectId {
  readonly name?: string;
}
interface DurableObjectStub {
  fetch(req: Request): Promise<Response>;
}
interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}
interface Env extends AccountEnv {
  ASSETS: { fetch(req: Request): Promise<Response> };
  AUDIO: R2Bucket;
  // SaaS layer (see accounts.ts): D1 + our registered Google web-OAuth app +
  // token encryption key. All set via `wrangler secret put` / D1 binding — never
  // committed. Absent in plain `vite` dev (use `wrangler dev` for these routes).
  DB: D1Database;
  GOOGLE_OAUTH_CLIENT_ID?: string;
  GOOGLE_OAUTH_CLIENT_SECRET?: string;
  TOKEN_ENC_KEY?: string;
  // One DjRoom per account coordinates a shared live set across the account's
  // devices. Optional so plain `vite` dev (no binding) degrades gracefully.
  ROOM?: DurableObjectNamespace;
  // Cloudflare Workers Rate Limiting bindings (wrangler.jsonc unsafe.bindings).
  // Per-IP caps on the unauthenticated write/resolve paths. Optional → absent in
  // plain `vite` dev, where `allow()` no-ops. RL_WRITE: catalog/analysis/stem
  // contributions; RL_AUDIO: cold-cache YouTube resolves.
  RL_WRITE?: RateLimiter;
  RL_AUDIO?: RateLimiter;
  // Allowed Origins for the shared-session WebSocket upgrade (comma-separated).
  // Defaults to the request's own origin when unset.
  WS_ALLOWED_ORIGINS?: string;
}

// Per-call cap on the client-supplied track array for /api/sync/match — bounds
// the YouTube subrequest fan-out (Worker subrequest limit / abuse).
const MAX_MATCH_TRACKS = 100;

// Don't buffer/cache absurdly large files (protect Worker memory) — stream those.
const MAX_CACHE_BYTES = 60 * 1024 * 1024;

const { searchYouTube, fetchPlaylist, getMyPlaylists } = createInnertubeApi(Innertube as never);

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

// Resolve the htl account from the session cookie (for the sync routes).
async function sessionUser(req: Request, env: Env) {
  if (!env.DB) return null;
  const sid = readSessionId(req);
  return sid ? userBySession(env.DB, sid) : null;
}

async function handleApi(url: URL, req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { allow: "GET, POST, PUT, OPTIONS" } });
  }
  try {
    // SaaS account / connected-service routes (D1-backed) get first refusal.
    const accountRes = await handleAccountRoute(url, req, env);
    if (accountRes) return accountRes;

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
              "x-content-type-options": "nosniff",
              "x-htl-cache": "hit",
              ...NO_CACHE,
            },
          });
        }

        // Cold cache → we're about to fetch from YouTube and write to R2. Rate-limit
        // this per IP so an anonymous client can't hammer it into a storage/egress bill.
        if (!(await allow(env.RL_AUDIO, clientIp(req)))) {
          return json(429, { error: "rate limited — try again shortly" });
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
          const h: Record<string, string> = { "content-type": r.contentType, "x-content-type-options": "nosniff", "x-htl-cache": "skip", ...NO_CACHE };
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
        // Tag the cached object with track metadata (lifted from the same player
        // response, no extra request) so the Community list can render names +
        // thumbnails straight from a single R2 list() call.
        const customMetadata = r.meta
          ? {
              title: r.meta.title.slice(0, 256),
              artist: r.meta.artist.slice(0, 128),
              duration: String(r.meta.duration),
              thumbnail: r.meta.thumbnail.slice(0, 400),
            }
          : undefined;
        ctx.waitUntil(env.AUDIO.put(key, buf, { httpMetadata: { contentType: r.contentType }, customMetadata }));
        // Index it in the community catalog (D1) so browse is an ordered query,
        // not a bucket scan. Best-effort; the table may not be migrated yet.
        if (env.DB && r.meta) {
          ctx.waitUntil(
            upsertCommunityTrack(env.DB, { videoId: v, title: r.meta.title, artist: r.meta.artist, duration: r.meta.duration, thumbnail: r.meta.thumbnail }).catch(() => {}),
          );
        }
        return new Response(buf, {
          headers: {
            "content-type": r.contentType,
            "content-length": String(total),
            "x-content-type-options": "nosniff",
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
        const a = readAuth(req);
        return json(200, await fetchPlaylist(listId, { cookie: a?.cookie, token: a?.accessToken }));
      }
      case "/api/me/playlists": {
        // The signed-in user's own playlists (private included). Browse is driven
        // by the cookie (preferred) or an OAuth token — one of them is required.
        const a = readAuth(req);
        if (!a?.cookie && !a?.accessToken) return json(401, { error: "connect YouTube first" });
        return json(200, { playlists: await getMyPlaylists({ cookie: a.cookie, token: a.accessToken }) });
      }
      case "/api/meta": {
        const v = url.searchParams.get("v");
        if (!isVideoId(v)) return json(400, { error: "missing or invalid ?v=" });
        return json(200, await fetchMeta(v, readAuth(req)));
      }
      case "/api/captions": {
        const v = url.searchParams.get("v");
        if (!isVideoId(v)) return json(400, { error: "missing or invalid ?v=" });
        // Durable cross-isolate cache: one lucky upstream pull serves every later
        // request. Writes are deferred so they never delay the response.
        const store = env.DB
          ? {
              get: (id: string) => getCachedCaptions(env.DB!, id),
              put: (id: string, cues: { start: number; end: number; text: string }[]) =>
                ctx.waitUntil(putCachedCaptions(env.DB!, id, cues).catch(() => {})),
            }
          : undefined;
        try {
          return json(200, { cues: await fetchCaptions(v, readAuth(req), store) });
        } catch {
          return json(200, { cues: [] }); // captions are optional — never fail the load
        }
      }
      case "/api/community": {
        // The shared cache, surfaced as a browsable pool. PRIMARY path: the D1
        // index (ordered, paginated, O(limit)). FALLBACK: scan R2 directly — used
        // pre-migration or before the one-time reindex has populated D1.
        const limit = Math.min(Number(url.searchParams.get("limit")) || 60, 200);

        if (env.DB) {
          try {
            const rows = await listCommunityTracks(env.DB, limit);
            if (rows.length) {
              return json(200, {
                tracks: rows.map((t) => ({
                  ...t,
                  thumbnail: t.thumbnail || `https://i.ytimg.com/vi/${t.videoId}/hqdefault.jpg`,
                  views: null,
                })),
              });
            }
          } catch {
            /* table not migrated yet → fall through to the R2 scan */
          }
        }

        // --- R2 scan fallback (metadata from customMetadata or an `m/` sidecar) ---
        const sidecar = new Map<string, Record<string, string>>();
        let sc: string | undefined;
        do {
          const page = await env.AUDIO.list({ prefix: "m/", limit: 1000, cursor: sc, include: ["customMetadata"] });
          for (const o of page.objects) {
            if (o.customMetadata?.title) sidecar.set(o.key.slice(2), o.customMetadata);
          }
          sc = page.truncated ? page.cursor : undefined;
        } while (sc);

        const tracks: TrackMeta[] = [];
        let cursor: string | undefined;
        do {
          const page = await env.AUDIO.list({ prefix: "a/", limit: 1000, cursor, include: ["customMetadata"] });
          for (const o of page.objects) {
            const v = o.key.slice(2); // strip "a/"
            if (!isVideoId(v)) continue;
            // Prefer the object's own metadata; fall back to the backfilled
            // sidecar; else thumbnail-only (the client backfills + persists it).
            const m = o.customMetadata?.title ? o.customMetadata : sidecar.get(v);
            tracks.push({
              videoId: v,
              title: m?.title || "",
              artist: m?.artist || "",
              duration: Number(m?.duration) || 0,
              thumbnail: m?.thumbnail || `https://i.ytimg.com/vi/${v}/hqdefault.jpg`,
              views: null,
            });
          }
          cursor = page.truncated ? page.cursor : undefined;
        } while (cursor && tracks.length < 1000);
        return json(200, { tracks: tracks.slice(0, limit) });
      }
      case "/api/room/invite": {
        // Mint (or fetch) the signed-in host's shareable session link. Guests open it
        // to join this account's session. The code is non-secret; the WS upgrade is
        // authed per-connection, so a code only names a session, it doesn't grant audio.
        if (req.method !== "POST") return json(405, { error: "POST only" });
        const user = await sessionUser(req, env);
        if (!user) return json(401, { error: "sign in to invite" });
        if (!env.DB) return json(503, { error: "not configured" });
        const code = await getOrCreateInvite(env.DB, user.id);
        return json(200, { code, url: `${url.origin}/?join=${code}` });
      }
      case "/api/community/meta": {
        // Durable metadata backfill for a community track (no audio bytes — a tiny
        // `m/<videoId>` sidecar). Anyone who resolves a legacy track's name writes
        // it here ONCE, and it's shared with every future visitor.
        if (req.method !== "POST") return json(405, { error: "POST only" });
        if (!(await allow(env.RL_WRITE, clientIp(req)))) return json(429, { error: "rate limited" });
        const b = (await req.json().catch(() => ({}))) as {
          videoId?: string;
          title?: string;
          artist?: string;
          duration?: number;
          thumbnail?: string;
        };
        if (!isVideoId(b.videoId ?? null) || !b.title) return json(400, { error: "missing videoId or title" });
        // Anonymous contribution → treat every field as hostile. Strip control chars,
        // clamp length, and accept ONLY http(s) thumbnails (no javascript:/data: that
        // could later be rendered somewhere). This is the write that fed the admin XSS.
        const title = cleanText(b.title, 256);
        if (!title) return json(400, { error: "empty title" });
        const artist = cleanText(b.artist, 128);
        const duration = clampNum(b.duration, 0, 86_400) ?? 0;
        const thumbnail = sanitizeHttpUrl(b.thumbnail) ?? "";
        await env.AUDIO.put(`m/${b.videoId}`, new Uint8Array(0), {
          customMetadata: { title, artist, duration: String(duration), thumbnail },
        });
        // Mirror into the D1 index so it shows up in the ordered browse.
        if (env.DB) {
          ctx.waitUntil(
            upsertCommunityTrack(env.DB, {
              videoId: b.videoId!,
              title,
              artist: artist || null,
              duration,
              thumbnail: thumbnail || null,
            }).catch(() => {}),
          );
        }
        return json(200, { ok: true });
      }
      case "/api/analysis": {
        // Crowdsourced analysis contribution (BPM/key/grid — facts about the
        // recording, not the recording). Any client that analyzes a track posts it;
        // this is the clean, publishable dataset. Best-effort, no auth.
        if (req.method !== "POST") return json(405, { error: "POST only" });
        if (!(await allow(env.RL_WRITE, clientIp(req)))) return json(429, { error: "rate limited" });
        const b = (await req.json().catch(() => ({}))) as {
          videoId?: string;
          bpm?: number;
          key?: string;
          keyName?: string;
          beatOffset?: number;
          duration?: number;
        };
        if (!isVideoId(b.videoId ?? null)) return json(400, { error: "bad videoId" });
        // This crowdsourced data is later published to a public HF dataset, so clamp
        // numerics to sane ranges and bound the key strings — no anonymous poster can
        // inject absurd values or oversized text into the export.
        if (env.DB) {
          ctx.waitUntil(
            upsertAnalysis(env.DB, {
              videoId: b.videoId!,
              bpm: clampNum(b.bpm, 1, 400),
              key: b.key != null ? cleanText(b.key, 8) : null,
              keyName: b.keyName != null ? cleanText(b.keyName, 32) : null,
              beatOffset: clampNum(b.beatOffset, -600, 600),
              duration: clampNum(b.duration, 0, 86_400),
            }).catch(() => {}),
          );
        }
        return json(200, { ok: true });
      }
      // NOTE: reindex + takedown are privileged moderation ops and live ONLY in
      // the Access-gated admin worker (admin.handlingtheloop.com / server/admin.ts),
      // never on the public domain.
      // --- Two-phase cross-service sync (review before commit) -------------
      // All require an htl session. Matching uses the free innertube search.
      case "/api/sync/source": {
        if (req.method !== "POST") return json(405, { error: "POST only" });
        const user = await sessionUser(req, env);
        if (!user) return json(401, { error: "sign in first" });
        const b = (await req.json().catch(() => ({}))) as { source?: Service; sourcePlaylistId?: string };
        if (!b.source || !b.sourcePlaylistId) return json(400, { error: "missing source or sourcePlaylistId" });
        return json(200, await readSource(env, user.id, b.source, b.sourcePlaylistId));
      }
      case "/api/sync/match": {
        if (req.method !== "POST") return json(405, { error: "POST only" });
        const user = await sessionUser(req, env);
        if (!user) return json(401, { error: "sign in first" });
        const b = (await req.json().catch(() => ({}))) as {
          dest?: Service;
          tracks?: SourceTrack[];
          startIndex?: number;
        };
        if (!b.dest || !Array.isArray(b.tracks)) return json(400, { error: "missing dest or tracks" });
        // Each track drives a YouTube search subrequest — cap the batch so a single
        // call can't blow the Worker subrequest limit / fan out abusively.
        if (b.tracks.length > MAX_MATCH_TRACKS) return json(413, { error: `too many tracks (max ${MAX_MATCH_TRACKS} per call)` });
        return json(200, { rows: await matchTracks(env, user.id, b.dest, b.tracks, b.startIndex ?? 0, { searchYouTube }) });
      }
      case "/api/sync/search": {
        if (req.method !== "POST") return json(405, { error: "POST only" });
        const user = await sessionUser(req, env);
        if (!user) return json(401, { error: "sign in first" });
        const b = (await req.json().catch(() => ({}))) as { dest?: Service; query?: string };
        if (!b.dest || !b.query?.trim()) return json(400, { error: "missing dest or query" });
        return json(200, { candidates: await searchDest(env, user.id, b.dest, b.query.trim(), { searchYouTube }) });
      }
      case "/api/sync/create": {
        if (req.method !== "POST") return json(405, { error: "POST only" });
        const user = await sessionUser(req, env);
        if (!user) return json(401, { error: "sign in first" });
        const b = (await req.json().catch(() => ({}))) as { dest?: Service; name?: string };
        if (!b.dest || !b.name) return json(400, { error: "missing dest or name" });
        return json(200, await createDestPlaylist(env, user.id, b.dest, b.name));
      }
      case "/api/sync/add": {
        if (req.method !== "POST") return json(405, { error: "POST only" });
        const user = await sessionUser(req, env);
        if (!user) return json(401, { error: "sign in first" });
        const b = (await req.json().catch(() => ({}))) as { dest?: Service; playlistId?: string; ids?: string[] };
        if (!b.dest || !b.playlistId || !Array.isArray(b.ids)) {
          return json(400, { error: "missing dest, playlistId, or ids" });
        }
        return json(200, { added: await addToDestPlaylist(env, user.id, b.dest, b.playlistId, b.ids) });
      }
      case "/api/stems": {
        // Shared stem cache, namespaced per separation model. PUT?v=&model=&s=<name>
        // stores one stem; GET?v=&model=&s= returns it; GET?v=&model= returns the
        // manifest of stems already cached for that model.
        const v = url.searchParams.get("v");
        if (!isVideoId(v)) return json(400, { error: "missing or invalid ?v=" });
        const model = (url.searchParams.get("model") || "dsp").toLowerCase();
        if (!/^[a-z0-9-]{1,32}$/.test(model)) return json(400, { error: "invalid ?model=" });
        const s = url.searchParams.get("s");
        const key = (name: string) => `s/${model}/${v}/${name}`;

        if (req.method === "PUT") {
          if (!s || !STEM_NAMES.includes(s)) return json(400, { error: "missing or invalid ?s=" });
          if (!(await allow(env.RL_WRITE, clientIp(req)))) return json(429, { error: "rate limited" });
          const buf = await req.arrayBuffer();
          if (buf.byteLength === 0 || buf.byteLength > MAX_STEM_BYTES) return json(413, { error: "bad stem size" });
          // Reject anything that isn't a recognized audio container. Without this an
          // anonymous client could store arbitrary bytes (e.g. HTML/JS) under a
          // predictable, fetchable key on our own origin.
          if (!looksLikeAudioStem(new Uint8Array(buf, 0, Math.min(buf.byteLength, 64)))) {
            return json(415, { error: "not a recognized audio stem" });
          }
          // We deliberately do NOT persist the client's Content-Type — GET always
          // serves a fixed opaque type (the client sniffs the magic header anyway).
          await env.AUDIO.put(key(s), buf, {
            httpMetadata: { contentType: STEM_DOWNLOAD_CONTENT_TYPE },
          });
          return json(200, { ok: true });
        }

        if (s) {
          if (!STEM_NAMES.includes(s)) return json(400, { error: "invalid ?s=" });
          const hit = await env.AUDIO.get(key(s));
          if (!hit) return json(404, { error: "stem not cached" });
          // Force a non-renderable type + nosniff + attachment: even if a legacy
          // object carries an HTML content-type, the browser can't execute it.
          return new Response(hit.body, {
            headers: {
              "content-type": STEM_DOWNLOAD_CONTENT_TYPE,
              "content-length": String(hit.size),
              "x-htl-cache": "hit",
              ...DOWNLOAD_SAFE_HEADERS,
              ...NO_CACHE,
            },
          });
        }

        const present: string[] = [];
        for (const name of STEM_NAMES) {
          if (await env.AUDIO.head(key(name))) present.push(name);
        }
        return json(200, { stems: present, complete: present.length === STEM_NAMES.length });
      }
      // --- Google device-code sign-in (see server/oauth.ts) ---------------
      // Stateless pass-throughs: the BROWSER holds the device_code / tokens and
      // polls; the Worker only forwards to Google. Nothing is stored here.
      case "/api/auth/device": {
        if (req.method !== "POST") return json(405, { error: "POST only" });
        return json(200, await startDeviceAuth(oauthCreds(env)));
      }
      case "/api/auth/poll": {
        if (req.method !== "POST") return json(405, { error: "POST only" });
        const { device_code } = (await req.json().catch(() => ({}))) as { device_code?: string };
        if (!device_code) return json(400, { error: "missing device_code" });
        return json(200, await pollDeviceAuth(oauthCreds(env), device_code));
      }
      case "/api/auth/refresh": {
        if (req.method !== "POST") return json(405, { error: "POST only" });
        const { refresh_token } = (await req.json().catch(() => ({}))) as { refresh_token?: string };
        if (!refresh_token) return json(400, { error: "missing refresh_token" });
        return json(200, await refreshAccessToken(oauthCreds(env), refresh_token));
      }
      default:
        return json(404, { error: `unknown endpoint ${url.pathname}` });
    }
  } catch (e) {
    return json(502, { error: (e as Error).message });
  }
}

// Shared-session WebSocket upgrade. Authed by the htl_session cookie (rides along
// same-origin), then routed to the per-account DjRoom DO. Kept out of handleApi so
// the 101 upgrade response passes through untouched (no JSON wrapping). The DO
// itself never sees credentials or audio — only control intents + track ids.
async function handleRoom(req: Request, env: Env): Promise<Response> {
  if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return json(426, { error: "expected a websocket upgrade" });
  }
  // Defense-in-depth against cross-site WebSocket hijacking. SameSite=Lax already
  // keeps the session cookie off cross-site handshakes, but also reject a mismatched
  // Origin outright. Allowlist defaults to this request's own origin; override via
  // WS_ALLOWED_ORIGINS (comma-separated) if the app is ever embedded elsewhere.
  const origin = req.headers.get("Origin");
  if (origin) {
    const allowed = (env.WS_ALLOWED_ORIGINS || new URL(req.url).origin)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!allowed.includes(origin)) return json(403, { error: "origin not allowed" });
  }
  if (!env.ROOM) return json(503, { error: "shared sessions are not configured" });
  const user = await sessionUser(req, env);

  // Which session? Signed-in users land in their OWN session by default (devices group),
  // or in a HOST's session when they open an invite code. ANONYMOUS users may join too,
  // but ONLY via a valid invite code (they can't own a session). The session key is
  // derived server-side, so a raw user id never appears in a URL.
  const url = new URL(req.url);
  const code = (url.searchParams.get("join") || "").trim();
  let hostId: string | null = user ? user.id : null;
  if (code && env.DB) {
    const owner = await inviteOwner(env.DB, code);
    if (owner) hostId = owner;
    else if (!user) return json(404, { error: "that invite link isn't valid" });
  }
  if (!hostId) return json(401, { error: "sign in, or open an invite link to join a session" });

  // Mark whether THIS connection is the session owner (a host device) vs an invited guest.
  // Authoritative + un-forgeable: we strip any client-supplied `host` and set it ourselves
  // from the authenticated identity. Guests can't grant themselves control (see the DO).
  const isHost = !!user && user.id === hostId;
  url.searchParams.delete("host");
  if (isHost) url.searchParams.set("host", "1");
  const stub = env.ROOM.get(env.ROOM.idFromName(`home:${hostId}`));
  return stub.fetch(new Request(url.toString(), req));
}

// The DjRoom Durable Object must be exported from the Worker entry so the runtime
// can find the class named in wrangler.jsonc's durable_objects binding.
export { DjRoom } from "../server/room";

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/api/room") return handleRoom(req, env);
    if (url.pathname.startsWith("/api/")) return handleApi(url, req, env, ctx);
    // Static SPA — but stamp every response with cross-origin-isolation headers so
    // `crossOriginIsolated` is true in the browser. That unlocks SharedArrayBuffer
    // and threaded WASM, so the desktop stem-separation workers (ORT threads,
    // demucs-rs) run multi-threaded instead of single-threaded (which stalls and
    // can get the tab killed). `credentialless` keeps cross-origin subresources —
    // YouTube thumbnails, the onnxruntime CDN, HuggingFace weights — loading.
    const res = await env.ASSETS.fetch(req);
    const headers = new Headers(res.headers);
    headers.set("Cross-Origin-Opener-Policy", "same-origin");
    headers.set("Cross-Origin-Embedder-Policy", "credentialless");
    // Baseline security headers (CSP, nosniff, framing, referrer, permissions).
    // CSP's script-src has no 'unsafe-inline', so an injected <script> can't run —
    // turning any residual HTML-injection from account-takeover into a no-op.
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  },
};
