// Pure-JS, Cloudflare-Worker-compatible YouTube audio resolution. No binaries,
// no child processes, no node: imports — only global fetch. Runs identically in
// the Vite dev middleware (Node) and a CF Worker.
//
// How it sidesteps YouTube's arms-race layers:
//   - Client: ANDROID_VR (clientName 28). yt-dlp's `REQUIRE_JS_PLAYER: false`
//     client — its formats carry DIRECT urls (no signatureCipher) and need no
//     PoToken, so there's nothing to decipher.
//   - Throttle: a naive single GET of a googlevideo url is capped to ~32 KB/s
//     unless the `n` param is solved. We never solve it — we download in 1 MB
//     RANGE chunks, which are served at full speed (~15 MB/s).
// The only off-browser need is CORS + the googlevideo IP-lock (the url is bound
// to the resolver's IP), so the Worker resolves AND fetches the bytes; the
// browser does the heavy compute (decode / analysis / DSP).

const ANDROID_VR_VERSION = "1.65.10";
const ANDROID_VR_UA =
  "com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip";

// ANDROID_VR's native host. Both anonymous and signed-in (cookie) calls use it —
// we never send a browser `Origin` header (see authHeaders), so there's no
// Origin/Host mismatch to dodge.
const PLAYER_ENDPOINT = "https://youtubei.googleapis.com/youtubei/v1/player?prettyPrint=false";

// Hard timeouts on every upstream call so a hung googlevideo / youtubei request
// can never pin the Worker until its wall-clock limit. AbortSignal.timeout is
// supported in workerd and Node 18+.
const PLAYER_TIMEOUT_MS = 8000;
const VISITOR_TIMEOUT_MS = 6000;
const CHUNK_TIMEOUT_MS = 25000;

function withTimeout(ms: number, init?: RequestInit): RequestInit {
  return { ...init, signal: AbortSignal.timeout(ms) };
}

// A fetch-shaped function. Threaded through the resolve + byte-stream chain so a single call
// site can route everything through the residential FortiGate relay instead of egressing from
// the (bot-walled) Cloudflare IP. Defaults to direct fetch everywhere → no behaviour change.
export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
const directFetch: Fetcher = (url, init) => fetch(url, init);

/** A Fetcher that tunnels each request through the residential relay (`relayUrl` = the
 *  cloudflared hostname). The relay forwards ONLY YouTube hosts and pins IPv4, so a resolve
 *  and its IP-locked googlevideo URL share the relay's IP. Used as the cold-load FALLBACK when
 *  the datacenter egress is bot-walled — see worker/index.ts. */
export function makeRelayFetch(
  relayUrl: string,
  secret: string,
  access?: { clientId: string; clientSecret: string },
): Fetcher {
  const endpoint = relayUrl.replace(/\/+$/, "") + "/fetch";
  return (url, init) => {
    const h: Record<string, string> = {
      "X-Relay-Secret": secret,
      "X-Relay-Target": url,
      "X-Relay-Method": (init?.method ?? "GET").toUpperCase(),
    };
    // Cloudflare Access service token (when configured): the relay hostname sits behind an Access
    // policy, so the Worker must present the service token or the edge blocks the request before it
    // reaches the tunnel. Absent creds → headers omitted (Access not enabled yet → secret-only).
    if (access) {
      h["CF-Access-Client-Id"] = access.clientId;
      h["CF-Access-Client-Secret"] = access.clientSecret;
    }
    new Headers(init?.headers).forEach((v, k) => (h["X-Fwd-" + k] = v));
    return fetch(endpoint, { method: "POST", headers: h, body: init?.body, signal: init?.signal });
  };
}

// Optional per-request YouTube credentials, supplied BY THE USER from their own
// browser session (see the privacy notice in the app). YouTube blocks the
// player API from datacenter IPs with LOGIN_REQUIRED ("confirm you're not a
// bot"); a real signed-in session (cookies) or a browser-minted visitorData /
// PO token passes that challenge. We thread these straight through to YouTube
// per request and never persist them server-side.
export interface YtAuth {
  cookie?: string; // the user's youtube.com Cookie header
  visitorData?: string; // a browser-minted visitorData (overrides our fetched one)
  poToken?: string; // a BotGuard PO token bound to that visitorData
  accessToken?: string; // OAuth 2.0 bearer from the device-code sign-in (see oauth.ts)
}

function cookieValue(cookie: string, name: string): string | null {
  const m = cookie.match(new RegExp("(?:^|;\\s*)" + name + "=([^;]+)"));
  return m ? m[1] : null;
}

async function sha1Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

// Headers for a cookie-authenticated player call against the ANDROID_VR client.
//
// CRITICAL: these must look like an ANDROID app request, not a browser one.
// SAPISIDHASH is the account proof (SHA1 over the youtube.com origin) and is
// always sent for a signed-in cookie — but Android clients DON'T send the
// browser-only `Origin`/`X-Origin` headers. Sending them alongside an ANDROID_VR
// context makes the request incoherent and YouTube returns
// `400 "Request contains an invalid argument."`. Omitting `Origin` also means the
// "Origin doesn't match Host" check never fires, so we can keep ANDROID_VR on its
// native youtubei.googleapis.com host. An ANONYMOUS cookie (no SAPISID) sends just
// the Cookie.
async function authHeaders(cookie: string): Promise<Record<string, string>> {
  const headers: Record<string, string> = { cookie };
  const sapisid =
    cookieValue(cookie, "SAPISID") ?? cookieValue(cookie, "__Secure-3PAPISID") ?? cookieValue(cookie, "__Secure-1PAPISID");
  if (sapisid) {
    const ts = Math.floor(Date.now() / 1000);
    headers.authorization = `SAPISIDHASH ${ts}_${await sha1Hex(`${ts} ${sapisid} https://www.youtube.com`)}`;
    headers["x-goog-authuser"] = "0";
  }
  return headers;
}

export interface ResolvedAudio {
  url: string;
  contentLength: number;
  contentType: string; // e.g. audio/mp4 or audio/webm
  itag: number;
  // Lifted from the same player response (no extra request) so the cache layer
  // can tag the stored object — powers the Community list without a second fetch.
  meta?: { title: string; artist: string; duration: number; thumbnail: string };
}

export interface TrackMeta {
  videoId: string;
  title: string;
  artist: string;
  duration: number;
  thumbnail: string | null;
  views: number | null;
}

interface RawFormat {
  itag: number;
  url?: string;
  mimeType: string;
  bitrate?: number;
  contentLength?: string;
}

// visitorData is reusable across videos for hours — cache it per isolate.
let visitorCache: { value: string; expires: number } | null = null;
const VISITOR_TTL_MS = 6 * 60 * 60 * 1000;

async function getVisitorData(force = false, fx: Fetcher = directFetch): Promise<string> {
  if (!force && visitorCache && visitorCache.expires > Date.now()) return visitorCache.value;
  // Lightweight source: the service-worker data blob carries VISITOR_DATA.
  const res = await fx(
    "https://www.youtube.com/sw.js_data",
    withTimeout(VISITOR_TIMEOUT_MS, { headers: { "user-agent": "Mozilla/5.0", "accept-language": "en-US,en;q=0.9" } }),
  );
  const text = await res.text();
  const m = text.match(/"(C[\w%-]+?)"/); // visitorData starts with "Cg..."
  let value = m ? m[1] : "";
  if (!value) {
    // Fallback: the watch page always has it.
    const html = await (
      await fx(
        "https://www.youtube.com/watch?v=jNQXAC9IVRw&hl=en",
        withTimeout(VISITOR_TIMEOUT_MS, { headers: { "user-agent": "Mozilla/5.0", "accept-language": "en-US" } }),
      )
    ).text();
    const wm = html.match(/"visitorData":"([^"]+)"/);
    value = wm ? JSON.parse('"' + wm[1] + '"') : "";
  }
  if (!value) throw new Error("could not obtain visitorData");
  visitorCache = { value, expires: Date.now() + VISITOR_TTL_MS };
  return value;
}

interface CaptionTrack {
  baseUrl?: string;
  languageCode?: string;
  kind?: string; // "asr" = auto-generated
}
interface PlayerResponse {
  error?: { code?: number; message?: string }; // API-level error envelope (non-player 4xx)
  playabilityStatus?: { status?: string; reason?: string };
  streamingData?: { adaptiveFormats?: RawFormat[] };
  captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: CaptionTrack[] } };
  videoDetails?: {
    videoId?: string;
    title?: string;
    author?: string;
    lengthSeconds?: string;
    viewCount?: string;
    thumbnail?: { thumbnails?: { url: string }[] };
  };
}

// A player "client" identity. Different clients return different things: the
// ANDROID family carries DIRECT stream urls (no signature cipher) — the property
// this whole project depends on — while WEB/TVHTML5 return ciphered urls we
// can't use. We only ever pick from clients known to yield direct urls.
interface PlayerClient {
  name: string;
  id: string; // X-Youtube-Client-Name
  version: string;
  ua?: string;
  extra?: Record<string, unknown>; // device fields baked into the context
}

const CLIENTS: Record<string, PlayerClient> = {
  ANDROID_VR: {
    name: "ANDROID_VR",
    id: "28",
    version: ANDROID_VR_VERSION,
    ua: ANDROID_VR_UA,
    extra: { deviceMake: "Oculus", deviceModel: "Quest 3", androidSdkVersion: 32, osName: "Android", osVersion: "12L" },
  },
  // For CAPTIONS only — these clients return the `captions` track list (ANDROID_VR
  // doesn't). We don't use their (ciphered / PO-gated) streams, just the caption
  // baseUrls, so version pickiness / PO-token gating on streams doesn't matter.
  ANDROID: {
    name: "ANDROID",
    id: "3",
    version: "19.09.37",
    ua: "com.google.android.youtube/19.09.37 (Linux; U; Android 14) gzip",
    extra: { androidSdkVersion: 34, osName: "Android", osVersion: "14" },
  },
  WEB: {
    name: "WEB",
    id: "1",
    version: "2.20240726.00.00",
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  },
};

interface PlayerOpts {
  client: PlayerClient;
  visitorData?: string;
  bearer?: string; // OAuth access token
  cookie?: string; // youtube.com cookie (SAPISIDHASH)
  poToken?: string;
}

// One raw player call. Returns the HTTP status alongside the parsed body (never
// throws on a non-2xx) so callers can diagnose / cascade across clients.
async function rawPlayer(videoId: string, o: PlayerOpts, fx: Fetcher = directFetch): Promise<{ http: number; body: PlayerResponse }> {
  const client: Record<string, unknown> = {
    ...o.client.extra,
    clientName: o.client.name,
    clientVersion: o.client.version,
    hl: "en",
    gl: "US",
  };
  if (o.client.ua) client.userAgent = o.client.ua;
  if (o.visitorData) client.visitorData = o.visitorData;

  const body: Record<string, unknown> = {
    videoId,
    context: { client },
    playbackContext: { contentPlaybackContext: { html5Preference: "HTML5_PREF_WANTS" } },
    contentCheckOk: true,
    racyCheckOk: true,
  };
  if (o.poToken) body.serviceIntegrityDimensions = { poToken: o.poToken };

  const headers: Record<string, string> = {
    "content-type": "application/json",
    "X-Youtube-Client-Name": o.client.id,
    "X-Youtube-Client-Version": o.client.version,
  };
  if (o.client.ua) headers["user-agent"] = o.client.ua;
  if (o.visitorData) headers["X-Goog-Visitor-Id"] = o.visitorData;
  // An OAuth bearer authenticates as the signed-in user; a cookie is the other way.
  if (o.bearer) headers.authorization = `Bearer ${o.bearer}`;
  else if (o.cookie) Object.assign(headers, await authHeaders(o.cookie));

  const res = await fx(
    PLAYER_ENDPOINT,
    withTimeout(PLAYER_TIMEOUT_MS, { method: "POST", headers, body: JSON.stringify(body) }),
  );
  let parsed: PlayerResponse = {};
  try {
    parsed = (await res.json()) as PlayerResponse;
  } catch {
    /* non-JSON (e.g. protobuf 400) — leave empty, http carries the signal */
  }
  return { http: res.status, body: parsed };
}

// Thin ANDROID_VR wrapper preserving the original throw-on-error contract used
// by the anonymous / cookie path.
async function playerRequest(videoId: string, visitorData: string, auth?: YtAuth, fx: Fetcher = directFetch): Promise<PlayerResponse> {
  const { http, body } = await rawPlayer(videoId, {
    client: CLIENTS.ANDROID_VR,
    visitorData,
    cookie: auth?.cookie,
    poToken: auth?.poToken,
  }, fx);
  if (http !== 200) {
    // Surface YouTube's own reason (e.g. "Origin doesn't match Host",
    // "invalid argument", "Precondition check failed") so a 400 is diagnosable
    // instead of opaque.
    const reason = body.error?.message || body.playabilityStatus?.reason;
    throw new Error(`player ${http}${reason ? `: ${reason}` : ""}`);
  }
  return body;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// YouTube intermittently 403s / LOGIN_REQUIREDs requests from datacenter IPs
// (Cloudflare's edge). Measured: the block is bursty per-egress-IP, not per-video — a
// given cold load fails only when ALL attempts land in a throttled window, and a FRESH
// visitorData on the next try is the lever that clears it (verified: rotating visitors
// rides out the bursts). So retry generously with jittered backoff. The latency cost is
// paid only on the rare fully-walled video; most resolve on attempt 0-1.
async function playerWithRetry(videoId: string, attempts = 6, auth?: YtAuth, fx: Fetcher = directFetch): Promise<PlayerResponse> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      // Prefer the user's browser-minted visitorData (it pairs with their PO token / cookie
      // and must stay fixed for that binding); otherwise fetch our own and ROTATE it every
      // retry (force=true once past attempt 0) so a burned token can't wall every attempt.
      const visitor = auth?.visitorData || (await getVisitorData(i > 0, fx));
      const pr = await playerRequest(videoId, visitor, auth, fx);
      if (pr.playabilityStatus?.status === "OK") return pr;
      lastErr = new Error(
        `not playable: ${pr.playabilityStatus?.status ?? "unknown"}${pr.playabilityStatus?.reason ? ` (${pr.playabilityStatus.reason})` : ""}`,
      );
    } catch (e) {
      lastErr = e; // HTTP 403 / 429 / 5xx
    }
    // Jittered backoff (capped) — the jitter de-synchronises concurrent cold loads so they
    // don't retry in lockstep and re-throttle the same egress together.
    if (i < attempts - 1) await sleep(Math.min(200 * (i + 1), 1000) + Math.floor(Math.random() * 200));
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

function pickAudio(formats: RawFormat[]): RawFormat | null {
  const audio = formats.filter((f) => f.mimeType?.startsWith("audio/") && f.url);
  if (audio.length === 0) return null;
  // Prefer m4a/AAC (decodeAudioData-safe on every browser incl. Safari),
  // otherwise the highest-bitrate audio (usually opus/webm).
  audio.sort((a, b) => {
    const am = a.mimeType.startsWith("audio/mp4") ? 1 : 0;
    const bm = b.mimeType.startsWith("audio/mp4") ? 1 : 0;
    if (am !== bm) return bm - am;
    return (b.bitrate ?? 0) - (a.bitrate ?? 0);
  });
  return audio[0];
}

// Streaming is ANONYMOUS-ONLY via ANDROID_VR (the only client that yields DIRECT,
// non-ciphered urls the worker can byte-stream). Account credentials can't unlock
// Premium formats on this client, so none are used — `auth` only ever carries a
// browser-minted visitorData / PO token that hardens the anonymous request against
// datacenter bot-blocks. `playerWithRetry` already retries with a fresh visitorData.
export async function resolveAudio(videoId: string, auth?: YtAuth, fx: Fetcher = directFetch): Promise<ResolvedAudio> {
  const pr = await playerWithRetry(videoId, 6, auth, fx);
  const fmt = pickAudio(pr.streamingData?.adaptiveFormats ?? []);
  if (!fmt || !fmt.url) throw new Error("no playable audio format");
  const d = pr.videoDetails;
  const thumbs = d?.thumbnail?.thumbnails;
  const meta = d?.videoId
    ? {
        title: d.title ?? d.videoId,
        artist: d.author ?? "",
        duration: Number(d.lengthSeconds) || 0,
        thumbnail: thumbs && thumbs.length ? thumbs[thumbs.length - 1].url : `https://i.ytimg.com/vi/${d.videoId}/hqdefault.jpg`,
      }
    : undefined;
  return {
    url: fmt.url,
    contentLength: Number(fmt.contentLength) || 0,
    contentType: fmt.mimeType.split(";")[0] || "audio/mp4",
    itag: fmt.itag,
    meta,
  };
}

// ---- cold-load diagnostics ---------------------------------------------------
// The anti-bot wall hits DIFFERENTLY per egress IP (a Cloudflare Worker IP is gated
// far harder than a dev box), so the only authoritative read is from the deployed
// worker itself. `diagnoseAudio` runs the real path + probes a cascade of alternate
// direct-url clients and reports each stage, non-throwing, so /api/audio/diag can
// show what YouTube actually returns here — and which client (if any) still works.
const DIAG_CLIENTS: PlayerClient[] = [
  CLIENTS.ANDROID_VR,
  { name: "IOS", id: "5", version: "19.45.4", ua: "com.google.ios.youtube/19.45.4 (iPhone16,2; U; CPU iOS 18_1_0 like Mac OS X)", extra: { deviceMake: "Apple", deviceModel: "iPhone16,2", osName: "iPhone", osVersion: "18.1.0.22B83" } },
  { name: "ANDROID", id: "3", version: "19.44.38", ua: "com.google.android.youtube/19.44.38 (Linux; U; Android 14) gzip", extra: { androidSdkVersion: 34, osName: "Android", osVersion: "14" } },
  { name: "WEB", id: "1", version: "2.20240726.00.00", ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36" },
  { name: "WEB_EMBEDDED_PLAYER", id: "56", version: "1.20241201.00.00" },
  { name: "TVHTML5_SIMPLY_EMBEDDED_PLAYER", id: "85", version: "2.0" },
  { name: "MWEB", id: "2", version: "2.20241202.07.00", ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1" },
];

export interface AudioDiag {
  videoId: string;
  egressIp: string; // the IP YouTube SEES — proves whether this ran from CF's edge or a dev box
  visitor: { ok: boolean; prefix: string; supplied: boolean };
  clients: Array<{ name: string; http: number; status: string; reason: string; error: string; formats: number; audioWithUrl: number; ciphered: number; firstItag: number | null }>;
  byteProbe: { client: string; itag: number; status: number; contentLength: string | null } | { error: string } | null;
}

// Report the worker's own egress IP (what YouTube sees) so a diag run is self-identifying —
// CF edge vs a local dev box look identical otherwise. cdn-cgi/trace is a plain-text k=v dump.
async function egressIp(): Promise<string> {
  try {
    const t = await (await fetch("https://www.cloudflare.com/cdn-cgi/trace", withTimeout(VISITOR_TIMEOUT_MS, {}))).text();
    return t.match(/^ip=(.+)$/m)?.[1] ?? "?";
  } catch {
    return "?";
  }
}

export async function diagnoseAudio(videoId: string, auth?: YtAuth): Promise<AudioDiag> {
  const egress = await egressIp();
  let visitor = auth?.visitorData || "";
  const supplied = !!auth?.visitorData;
  if (!visitor) {
    try {
      visitor = await getVisitorData();
    } catch {
      /* leave empty — the report will show LOGIN_REQUIRED, which IS the diagnosis */
    }
  }
  const clients: AudioDiag["clients"] = [];
  let byteProbe: AudioDiag["byteProbe"] = null;
  for (const client of DIAG_CLIENTS) {
    try {
      const { http, body } = await rawPlayer(videoId, { client, visitorData: visitor || undefined, cookie: auth?.cookie, poToken: auth?.poToken });
      const fmts = body.streamingData?.adaptiveFormats ?? [];
      const audio = fmts.filter((f) => f.mimeType?.startsWith("audio/"));
      const withUrl = audio.filter((f) => f.url);
      const ciphered = audio.filter((f) => !f.url && ((f as unknown as { signatureCipher?: string }).signatureCipher));
      clients.push({
        name: client.name,
        http,
        status: body.playabilityStatus?.status ?? "—",
        reason: body.playabilityStatus?.reason ?? "",
        error: body.error?.message ?? "",
        formats: fmts.length,
        audioWithUrl: withUrl.length,
        ciphered: ciphered.length,
        firstItag: withUrl[0]?.itag ?? null,
      });
      // First client that yields a direct url → probe the byte stage (range 0-1KB).
      if (!byteProbe && withUrl[0]?.url) {
        try {
          const r = await fetch(withUrl[0].url, withTimeout(PLAYER_TIMEOUT_MS, { headers: { range: "bytes=0-1023" } }));
          byteProbe = { client: client.name, itag: withUrl[0].itag, status: r.status, contentLength: r.headers.get("content-length") };
        } catch (e) {
          byteProbe = { error: e instanceof Error ? e.message : String(e) };
        }
      }
    } catch (e) {
      clients.push({ name: client.name, http: 0, status: "THREW", reason: e instanceof Error ? e.message : String(e), error: "", formats: 0, audioWithUrl: 0, ciphered: 0, firstItag: null });
    }
  }
  return { videoId, egressIp: egress, visitor: { ok: !!visitor, prefix: visitor.slice(0, 12), supplied }, clients, byteProbe };
}

/** Single-video metadata from the player response's videoDetails. */
export async function fetchMeta(videoId: string, auth?: YtAuth): Promise<TrackMeta> {
  // Same anonymous ANDROID_VR path as resolveAudio.
  const pr = await playerWithRetry(videoId, 6, auth);
  const d = pr.videoDetails;
  if (!d?.videoId) throw new Error("no metadata");
  const thumbs = d.thumbnail?.thumbnails;
  return {
    videoId: d.videoId,
    title: d.title ?? d.videoId,
    artist: d.author ?? "",
    duration: Number(d.lengthSeconds) || 0,
    thumbnail: thumbs && thumbs.length ? thumbs[thumbs.length - 1].url : `https://i.ytimg.com/vi/${d.videoId}/hqdefault.jpg`,
    views: Number(d.viewCount) || null,
  };
}

export interface CaptionCue {
  start: number; // seconds
  end: number;
  text: string;
}

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&apos;": "'" };
function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&(?:amp|lt|gt|quot|#39|apos);/g, (e) => ENTITIES[e] ?? e);
}

// The video's caption track list. ANDROID_VR (the stream client) omits it, so we
// ask the ANDROID / WEB clients (which carry `captions`) until one answers.
async function captionTracks(videoId: string, auth?: YtAuth, freshVisitor = false): Promise<CaptionTrack[]> {
  // On a retry we force a brand-new visitorData: a session that's "bad" for captions
  // fails identically every time, so reusing the cached one would waste the retry.
  const visitor = auth?.visitorData || (await getVisitorData(freshVisitor).catch(() => ""));
  for (const client of [CLIENTS.ANDROID_VR, CLIENTS.ANDROID, CLIENTS.WEB]) {
    try {
      const { body } = await rawPlayer(videoId, { client, visitorData: visitor || undefined, poToken: auth?.poToken });
      const tracks = body.captions?.playerCaptionsTracklistRenderer?.captionTracks;
      if (tracks?.length) return tracks;
    } catch {
      /* try the next client */
    }
  }
  return [];
}

// Parse any timedtext format YouTube hands back: json3 (preferred), legacy srv1
// (<text start dur> in seconds), or srv3 (<p t d> in milliseconds, with <s> word
// spans). ANDROID_VR's caption urls default to srv3 and ignore an appended &fmt=.
function parseTimedText(text: string): CaptionCue[] {
  const cues: CaptionCue[] = [];
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    try {
      const data = JSON.parse(trimmed) as { events?: { tStartMs?: number; dDurationMs?: number; segs?: { utf8?: string }[] }[] };
      for (const e of data.events ?? []) {
        if (e.tStartMs == null || !e.segs) continue;
        const t = e.segs.map((s) => s.utf8 ?? "").join("").replace(/\s+/g, " ").trim();
        if (t) cues.push({ start: e.tStartMs / 1000, end: (e.tStartMs + (e.dDurationMs ?? 0)) / 1000, text: t });
      }
      if (cues.length) return cues;
    } catch {
      /* not json — fall through to XML */
    }
  }
  let m: RegExpExecArray | null;
  const reText = /<text start="([\d.]+)"(?: dur="([\d.]+)")?[^>]*>([\s\S]*?)<\/text>/g;
  while ((m = reText.exec(text))) {
    const start = parseFloat(m[1]);
    const dur = parseFloat(m[2] || "0");
    const t = decodeEntities(m[3].replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
    if (t && !Number.isNaN(start)) cues.push({ start, end: start + (Number.isNaN(dur) ? 0 : dur), text: t });
  }
  if (cues.length) return cues;
  const reP = /<p t="(\d+)"(?: d="(\d+)")?[^>]*>([\s\S]*?)<\/p>/g;
  while ((m = reP.exec(text))) {
    const tMs = parseInt(m[1], 10);
    const dMs = parseInt(m[2] || "0", 10);
    const t = decodeEntities(m[3].replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
    if (t) cues.push({ start: tMs / 1000, end: (tMs + dMs) / 1000, text: t });
  }
  return cues;
}

// Successful caption pulls, memoized for the isolate's lifetime. The whole upstream
// path (track-list player call + timedtext fetch) is IP/session-bound and lands cues
// only ~1 in 5 tries from the datacenter — so once a request gets lucky, every later
// request (and the other deck) serves instantly instead of re-rolling the dice.
const captionCache = new Map<string, CaptionCue[]>();

// One full attempt: list the caption tracks, pick an English one (manual over auto),
// fetch + parse the timedtext. Any flake anywhere yields [].
async function fetchCaptionsOnce(videoId: string, auth?: YtAuth, freshVisitor = false): Promise<CaptionCue[]> {
  const tracks = await captionTracks(videoId, auth, freshVisitor);
  if (!tracks.length) return [];
  const en = (t: CaptionTrack) => t.languageCode?.toLowerCase().startsWith("en");
  const pick =
    tracks.find((t) => en(t) && t.kind !== "asr") ?? tracks.find(en) ?? tracks.find((t) => t.kind !== "asr") ?? tracks[0];
  if (!pick?.baseUrl) return [];
  // json3 is cleanest, but fall back to the track's native format (srv1/srv3, both
  // handled by parseTimedText) if the fmt swap comes back empty.
  const base = pick.baseUrl.replace(/&fmt=[^&]*/g, "");
  for (const url of [base + "&fmt=json3", pick.baseUrl]) {
    try {
      const res = await fetch(url, withTimeout(8000, { headers: { "user-agent": "Mozilla/5.0" } }));
      if (!res.ok) continue;
      const cues = parseTimedText(await res.text());
      if (cues.length) return cues;
    } catch {
      /* try the next format */
    }
  }
  return [];
}

// A durable, cross-isolate caption cache (D1-backed in the worker). Optional — the
// dev server runs without one and just leans on the in-memory memo + retries.
export interface CaptionStore {
  get(videoId: string): Promise<CaptionCue[] | null>;
  put(videoId: string, cues: CaptionCue[]): void; // fire-and-forget (e.g. ctx.waitUntil)
}

// Timestamped captions for a video. Returns [] when the video genuinely has no
// captions (most music). Resolution order: in-memory memo → durable store → up to 5
// upstream tries (rotating the session each retry), persisting the first success.
export async function fetchCaptions(videoId: string, auth?: YtAuth, store?: CaptionStore): Promise<CaptionCue[]> {
  const memo = captionCache.get(videoId);
  if (memo) return memo;
  if (store) {
    const hit = await store.get(videoId).catch(() => null);
    if (hit?.length) {
      captionCache.set(videoId, hit);
      return hit;
    }
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    // First try rides the (fast) cached session; every retry forces a fresh one.
    const cues = await fetchCaptionsOnce(videoId, auth, attempt > 0).catch(() => []);
    if (cues.length) {
      captionCache.set(videoId, cues);
      store?.put(videoId, cues);
      return cues;
    }
  }
  return [];
}

/**
 * Yield the audio as 1 MB range chunks. Range requests dodge googlevideo's
 * single-stream throttle, so this runs at full bandwidth without solving `n`.
 */
// Cloudflare Workers cap subrequests per request (50 on the free plan), so we
// size chunks to keep the count bounded no matter how long the track is — a
// 2-hour mix still resolves in ~24 range fetches. Larger ranges are also faster
// (fewer round trips) and, crucially, NOT throttled — only a no-range GET is.
const MIN_CHUNK = 8 * 1024 * 1024; // 8 MB floor
const MAX_CHUNKS = 24;

// Fetch one byte range, retrying transient failures (intermittent 403/429/5xx
// from datacenter IPs, or a timeout) so a single flaky chunk doesn't fail the
// whole track.
async function fetchRange(url: string, start: number, end: number, attempts = 3, fx: Fetcher = directFetch): Promise<Uint8Array> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fx(url, withTimeout(CHUNK_TIMEOUT_MS, { headers: { range: `bytes=${start}-${end}` } }));
      if (r.ok || r.status === 206) return new Uint8Array(await r.arrayBuffer());
      lastErr = new Error(`chunk ${r.status}`);
      if (r.status !== 403 && r.status !== 429 && r.status < 500) throw lastErr; // non-transient
    } catch (e) {
      lastErr = e;
    }
    if (i < attempts - 1) await sleep(200 * (i + 1));
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

// Stream the resolved audio as range chunks. `reresolve` (optional) mints a FRESH
// stream URL: `fetchRange` already retries a flaky chunk, but a googlevideo URL can go
// wholesale-dead — the session gets flagged, or the URL expires partway through a long
// track — and then every retry hits the same dead URL identically (the stuck-"fail"
// mode). On a range that fails all its retries we re-resolve ONCE and resume the SAME
// byte range from the new URL. We only resume when the fresh format matches the original
// itag, since byte offsets wouldn't line up across a different format (we'd corrupt the
// stream) — a format switch just surfaces the original error.
export async function* audioChunks(
  resolved: Pick<ResolvedAudio, "url" | "contentLength" | "itag">,
  reresolve?: () => Promise<ResolvedAudio>,
  fx: Fetcher = directFetch,
): AsyncGenerator<Uint8Array> {
  let { url } = resolved;
  const { contentLength, itag } = resolved;
  let reresolved = false;
  // One-shot re-resolve guard shared by both the single-GET and ranged paths.
  const freshUrl = async (origErr: unknown): Promise<string> => {
    if (!reresolve || reresolved) throw origErr;
    reresolved = true;
    const fresh = await reresolve();
    if (fresh.itag !== itag) throw origErr; // format changed → byte offsets won't align
    return (url = fresh.url);
  };

  // If contentLength is unknown, fall back to a single streamed GET (re-resolved once if
  // the initial GET is rejected outright).
  if (!contentLength) {
    let r = await fx(url, withTimeout(CHUNK_TIMEOUT_MS));
    if (!r.ok || !r.body) {
      const u = await freshUrl(new Error(`audio ${r.status}`));
      r = await fx(u, withTimeout(CHUNK_TIMEOUT_MS));
      if (!r.ok || !r.body) throw new Error(`audio ${r.status}`);
    }
    const reader = r.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      yield value;
    }
    return;
  }
  const chunkSize = Math.max(MIN_CHUNK, Math.ceil(contentLength / MAX_CHUNKS));
  for (let start = 0; start < contentLength; start += chunkSize) {
    const end = Math.min(contentLength - 1, start + chunkSize - 1);
    try {
      yield await fetchRange(url, start, end, 3, fx);
    } catch (e) {
      yield await fetchRange(await freshUrl(e), start, end, 3, fx);
    }
  }
}
