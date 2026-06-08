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

const PLAYER_ENDPOINT = "https://youtubei.googleapis.com/youtubei/v1/player?prettyPrint=false";

export interface ResolvedAudio {
  url: string;
  contentLength: number;
  contentType: string; // e.g. audio/mp4 or audio/webm
  itag: number;
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

async function getVisitorData(force = false): Promise<string> {
  if (!force && visitorCache && visitorCache.expires > Date.now()) return visitorCache.value;
  // Lightweight source: the service-worker data blob carries VISITOR_DATA.
  const res = await fetch("https://www.youtube.com/sw.js_data", {
    headers: { "user-agent": "Mozilla/5.0", "accept-language": "en-US,en;q=0.9" },
  });
  const text = await res.text();
  const m = text.match(/"(C[\w%-]+?)"/); // visitorData starts with "Cg..."
  let value = m ? m[1] : "";
  if (!value) {
    // Fallback: the watch page always has it.
    const html = await (
      await fetch("https://www.youtube.com/watch?v=jNQXAC9IVRw&hl=en", {
        headers: { "user-agent": "Mozilla/5.0", "accept-language": "en-US" },
      })
    ).text();
    const wm = html.match(/"visitorData":"([^"]+)"/);
    value = wm ? JSON.parse('"' + wm[1] + '"') : "";
  }
  if (!value) throw new Error("could not obtain visitorData");
  visitorCache = { value, expires: Date.now() + VISITOR_TTL_MS };
  return value;
}

interface PlayerResponse {
  playabilityStatus?: { status?: string; reason?: string };
  streamingData?: { adaptiveFormats?: RawFormat[] };
  videoDetails?: {
    videoId?: string;
    title?: string;
    author?: string;
    lengthSeconds?: string;
    viewCount?: string;
    thumbnail?: { thumbnails?: { url: string }[] };
  };
}

async function playerRequest(videoId: string, visitorData: string): Promise<PlayerResponse> {
  const body = {
    videoId,
    context: {
      client: {
        clientName: "ANDROID_VR",
        clientVersion: ANDROID_VR_VERSION,
        deviceMake: "Oculus",
        deviceModel: "Quest 3",
        androidSdkVersion: 32,
        userAgent: ANDROID_VR_UA,
        osName: "Android",
        osVersion: "12L",
        hl: "en",
        gl: "US",
        visitorData,
      },
    },
    playbackContext: { contentPlaybackContext: { html5Preference: "HTML5_PREF_WANTS" } },
    contentCheckOk: true,
    racyCheckOk: true,
  };
  const res = await fetch(PLAYER_ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Youtube-Client-Name": "28",
      "X-Youtube-Client-Version": ANDROID_VR_VERSION,
      "user-agent": ANDROID_VR_UA,
      "X-Goog-Visitor-Id": visitorData,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`player ${res.status}`);
  return res.json();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// YouTube intermittently 403s / LOGIN_REQUIREDs requests from datacenter IPs
// (Cloudflare's edge). Retry with backoff and a fresh visitorData — in practice
// the next attempt almost always succeeds.
async function playerWithRetry(videoId: string, attempts = 4): Promise<PlayerResponse> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const pr = await playerRequest(videoId, await getVisitorData(i > 0));
      if (pr.playabilityStatus?.status === "OK") return pr;
      lastErr = new Error(
        `not playable: ${pr.playabilityStatus?.status ?? "unknown"}${pr.playabilityStatus?.reason ? ` (${pr.playabilityStatus.reason})` : ""}`,
      );
    } catch (e) {
      lastErr = e; // HTTP 403 / 429 / 5xx
    }
    if (i < attempts - 1) await sleep(250 * (i + 1));
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

export async function resolveAudio(videoId: string): Promise<ResolvedAudio> {
  const pr = await playerWithRetry(videoId);
  const fmt = pickAudio(pr.streamingData?.adaptiveFormats ?? []);
  if (!fmt || !fmt.url) throw new Error("no playable audio format");
  return {
    url: fmt.url,
    contentLength: Number(fmt.contentLength) || 0,
    contentType: fmt.mimeType.split(";")[0] || "audio/mp4",
    itag: fmt.itag,
  };
}

/** Single-video metadata from the ANDROID_VR player response's videoDetails. */
export async function fetchMeta(videoId: string): Promise<TrackMeta> {
  const pr = await playerWithRetry(videoId);
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

export async function* audioChunks(url: string, contentLength: number): AsyncGenerator<Uint8Array> {
  // If contentLength is unknown, fall back to a single streamed GET.
  if (!contentLength) {
    const r = await fetch(url);
    if (!r.ok || !r.body) throw new Error(`audio ${r.status}`);
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
    const r = await fetch(url, { headers: { range: `bytes=${start}-${end}` } });
    if (!r.ok && r.status !== 206) throw new Error(`chunk ${r.status}`);
    yield new Uint8Array(await r.arrayBuffer());
  }
}
