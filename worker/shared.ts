// Shared worker scaffolding: the Env binding shape, the hand-rolled Cloudflare type
// interfaces (this project deliberately does NOT pull @cloudflare/workers-types — see
// htl-dev-workflow), and the small helpers every route group reaches for. index.ts and
// every worker/routes/* module import from here. Pure relocation out of the old monolith.
import { Innertube } from "youtubei.js/cf-worker";
import { createInnertubeApi } from "../server/innertube";
import { type AccountEnv } from "../server/accounts";
import { type D1Database, userBySession } from "../server/db";
import { readSessionId } from "../server/session";
import { type RateLimiter } from "../server/security";
import { type YtAuth } from "../server/youtube";

// ---- hand-rolled Cloudflare runtime types ------------------------------------
export interface R2ObjectBody {
  body: ReadableStream;
  size: number;
  httpMetadata?: { contentType?: string };
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}
export interface R2Object {
  key: string;
  size: number;
  customMetadata?: Record<string, string>;
}
export interface R2Bucket {
  get(key: string): Promise<R2ObjectBody | null>;
  head(key: string): Promise<{ size: number } | null>;
  put(
    key: string,
    value: ArrayBuffer | Uint8Array | string | ReadableStream<Uint8Array>,
    opts?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> },
  ): Promise<unknown>;
  delete(key: string): Promise<void>;
  list(opts?: {
    prefix?: string;
    limit?: number;
    cursor?: string;
    delimiter?: string;
    include?: ("customMetadata" | "httpMetadata")[];
  }): Promise<{ objects: R2Object[]; truncated: boolean; cursor?: string; delimitedPrefixes?: string[] }>;
}
export interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}
// Durable Object binding for the shared-session rooms (server/room.ts).
export interface DurableObjectId {
  readonly name?: string;
}
export interface DurableObjectStub {
  fetch(req: Request): Promise<Response>;
}
export interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}

export interface Env extends AccountEnv {
  ASSETS: { fetch(req: Request): Promise<Response> };
  AUDIO: R2Bucket;
  // SaaS layer (see accounts.ts): D1 + our registered Google web-OAuth app +
  // token encryption key. All set via `wrangler secret put` / D1 binding — never
  // committed. Absent in plain `vite` dev (use `wrangler dev` for these routes).
  DB: D1Database;
  GOOGLE_OAUTH_CLIENT_ID?: string;
  GOOGLE_OAUTH_CLIENT_SECRET?: string;
  TOKEN_ENC_KEY?: string;
  /** Bearer for the DO→Worker internal bridge (/internal/notify, /internal/presence). Falls back
   *  to TOKEN_ENC_KEY when unset, which is how it shipped — but they are different jobs and one of
   *  them travels in a request header, so give it its own secret where you can:
   *  `wrangler secret put INTERNAL_SECRET`. */
  INTERNAL_SECRET?: string;
  // One DjRoom per account coordinates a shared live set across the account's
  // devices. Optional so plain `vite` dev (no binding) degrades gracefully.
  ROOM?: DurableObjectNamespace;
  RELAY?: DurableObjectNamespace; // D2: RelayRoom crowd shards (only used when RELAY_SHARDS>0)
  RELAY_SHARDS?: string; // number of relay shards per room (0/unset = relay tier OFF)
  // Residential YouTube-fetch relay (a FortiGate over cloudflared). When BOTH are set, a cold
  // resolve that the datacenter egress can't get (bot wall, after retries) is retried through
  // the relay's residential IP. Unset → feature inert (the cold path just 502s as before).
  YT_RELAY_URL?: string; // e.g. https://relay-b.handlingtheloop.com
  YT_RELAY_SECRET?: string; // shared secret the relay enforces
  CF_ACCESS_CLIENT_ID?: string; // Cloudflare Access service-token id — gates the relay hostname at the edge
  CF_ACCESS_CLIENT_SECRET?: string; // Cloudflare Access service-token secret (paired with the id above)
  // Cloudflare Workers Rate Limiting bindings (wrangler.jsonc unsafe.bindings).
  // Per-IP caps on the unauthenticated write/resolve paths. Optional → absent in
  // plain `vite` dev, where `allow()` no-ops. RL_WRITE: catalog/analysis/stem
  // contributions; RL_AUDIO: cold-cache YouTube resolves.
  RL_WRITE?: RateLimiter;
  RL_AUDIO?: RateLimiter;
  RL_ACOUSTID?: RateLimiter; // caps outbound AcoustID lookups (≤3/s) across the account
  ACOUSTID_API_KEY?: string; // AcoustID application key (`wrangler secret put` / .dev.vars)
  // Allowed Origins for the shared-session WebSocket upgrade (comma-separated).
  // Defaults to the request's own origin when unset.
  WS_ALLOWED_ORIGINS?: string;
  /** The app's own hostname, e.g. "app.handlingtheloop.com". UNSET = one origin serves everything
   *  (what ships today). Set it and the bare domain becomes a landing site — see server/hosts.ts. */
  APP_HOST?: string;
  /** The ONE marketing hostname that counts, e.g. "handlingtheloop.com". Any other routed host
   *  (www, a stray alias) 301s to it — the API, the socket and /.well-known are exempt, and dev /
   *  workers.dev previews are left alone. Independent of APP_HOST: this fixes apex-and-www both
   *  claiming to be canonical, which is true today with no split at all. */
  SITE_HOST?: string;
}

// ---- constants ---------------------------------------------------------------
// 4-stem model (Demucs order). Stems are cached in R2 by videoId so they're
// separated ONCE (by a capable browser) and then DOWNLOADED by everyone else.
export const STEM_NAMES = ["vocals", "drums", "bass", "other"];
// Stems are cached as 16-bit WAV (~11 MB/min stereo); 160 MB covers ~12 min.
export const MAX_STEM_BYTES = 160 * 1024 * 1024;
// Per-call cap on the client-supplied track array for /api/sync/match — bounds
// the YouTube subrequest fan-out (Worker subrequest limit / abuse).
export const MAX_MATCH_TRACKS = 100;
// Don't buffer/cache absurdly large files (protect Worker memory) — stream those.
export const MAX_CACHE_BYTES = 60 * 1024 * 1024;
// Same-origin SPA+API: no CORS (so the resolver can't be an open proxy); no-store
// keeps resolved audio out of intermediary caches.
export const NO_CACHE = { "cache-control": "no-store" };

// ---- innertube API singletons (created once per isolate) ---------------------
export const { searchYouTube, fetchPlaylist, getMyPlaylists, getWatchNext } = createInnertubeApi(Innertube as never);

// ---- helpers -----------------------------------------------------------------
export function json(status: number, body: unknown, headers?: Record<string, string>): Response {
  // NO_CACHE is the default; pass `headers` to override it (e.g. a deterministic, cacheable read).
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...NO_CACHE, ...headers },
  });
}

export const isVideoId = (v: string | null): v is string => !!v && /^[\w-]{11}$/.test(v);

// User-supplied YouTube credentials, forwarded per request from their browser (never
// stored). Lets each user pass YouTube's "not a bot" challenge with their own session.
export function readAuth(req: Request): YtAuth | undefined {
  const visitorData = req.headers.get("x-htl-yt-visitor") || undefined;
  const poToken = req.headers.get("x-htl-yt-potoken") || undefined;
  const accessToken = req.headers.get("x-htl-yt-token") || undefined;
  return visitorData || poToken || accessToken ? { visitorData, poToken, accessToken } : undefined;
}

// Strip the noise YouTube uploaders cram into titles (resolution/format/"official
// video" tags) so the leftover "Artist - Song" matches a music catalog. Duration —
// not the title — is what we trust for length; this is only for NAME matching.
const TITLE_JUNK = /\b(official|video|audio|lyrics?|hd|hq|4k|uhd|1080p|720p|480p|full\s*hd|visualizer|remaster(?:ed)?|explicit|m\/?v)\b/i;
export function cleanVideoTitle(s: string): string {
  return s
    .replace(/\([^)]*\)/g, (m) => (TITLE_JUNK.test(m) ? " " : m))
    .replace(/\[[^\]]*\]/g, (m) => (TITLE_JUNK.test(m) ? " " : m))
    .replace(/\|\|?\s*(hd|hq|4k|1080p|720p|full\s*hd)\b.*$/gi, " ")
    .replace(/\b(official\s+(?:music\s+)?video|official\s+audio|lyric\s+video|music\s+video)\b/gi, " ")
    .replace(/\s{2,}/g, " ")
    .replace(/\s*[-–—]\s*$/, "")
    .trim();
}

// The set of videoIds with cached stems, derived from a delimited walk of the stem
// keyspace (`s/<model>/<videoId>/<stem>`). Per-isolate memo so back-to-back Library/Search
// requests don't each re-walk the keyspace with Class-A list() ops.
let stemIdsMemo: { ids: Set<string>; at: number } | null = null;
const STEM_IDS_TTL_MS = 60_000;
export async function stemCachedIds(env: Env): Promise<Set<string>> {
  if (stemIdsMemo && Date.now() - stemIdsMemo.at < STEM_IDS_TTL_MS) return stemIdsMemo.ids;
  const ids = new Set<string>();
  const models = await env.AUDIO.list({ prefix: "s/", delimiter: "/" });
  for (const mp of models.delimitedPrefixes ?? []) {
    // mp = "s/<model>/" — list its videoId sub-prefixes.
    let cursor: string | undefined;
    do {
      const page = await env.AUDIO.list({ prefix: mp, delimiter: "/", cursor });
      for (const vp of page.delimitedPrefixes ?? []) {
        const vid = vp.slice(mp.length, -1); // strip "s/<model>/" prefix + trailing "/"
        if (isVideoId(vid)) ids.add(vid);
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }
  stemIdsMemo = { ids, at: Date.now() };
  return ids;
}

// Resolve the htl account from the session cookie (for the auth-gated routes).
export async function sessionUser(req: Request, env: Env) {
  if (!env.DB) return null;
  const sid = readSessionId(req);
  return sid ? userBySession(env.DB, sid) : null;
}
