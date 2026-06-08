// Edge function: GET /api/audio?v=<videoId>
//
// Resolves a YouTube audio-only stream and proxies the bytes back to the
// browser WITH CORS headers, so the client can fetch + decodeAudioData. This is
// the one piece that must run off-browser, because googlevideo.com does not
// allow cross-origin reads and YouTube's player response isn't reachable from a
// web page.
//
// Deploys as a Vercel Edge Function or a Cloudflare Worker (both serverless).
//
// SCOPE / HONESTY:
//   - Implemented: Innertube player-response fetch, pick best audio-only format,
//     stream-proxy formats that expose a direct `url`.
//   - NOT yet implemented: signatureCipher / n-param deciphering (needs base.js
//     parsing). Some videos only expose ciphered URLs and will 422 until that
//     lands. This is the deliberate next chunk of work.
//   - Consent: the app is intended for non-copyrighted / cleared material. A
//     real deployment should gate this behind an explicit user attestation and
//     respect rate limits / robots. Keep that gate on the client + here.

export const config = { runtime: "edge" };

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

interface AdaptiveFormat {
  itag: number;
  url?: string;
  signatureCipher?: string;
  mimeType: string;
  bitrate?: number;
  contentLength?: string;
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  const videoId = new URL(req.url).searchParams.get("v");
  if (!videoId || !/^[\w-]{11}$/.test(videoId)) {
    return json(400, { error: "missing or invalid ?v= video id" });
  }

  let player: PlayerResponse;
  try {
    player = await fetchPlayerResponse(videoId);
  } catch (e) {
    return json(502, { error: `player fetch failed: ${String(e)}` });
  }

  if (player.playabilityStatus?.status !== "OK") {
    return json(403, {
      error: `not playable: ${player.playabilityStatus?.status ?? "unknown"}`,
      reason: player.playabilityStatus?.reason,
    });
  }

  const formats = player.streamingData?.adaptiveFormats ?? [];
  const audio = pickBestAudio(formats);
  if (!audio) return json(422, { error: "no audio-only format found" });
  if (!audio.url) {
    // Ciphered URL — deciphering not yet implemented (see scope note above).
    return json(422, { error: "stream is ciphered; deciphering not implemented yet" });
  }

  const upstream = await fetch(audio.url, {
    headers: req.headers.get("range")
      ? { range: req.headers.get("range")! }
      : undefined,
  });
  if (!upstream.ok && upstream.status !== 206) {
    return json(502, { error: `upstream ${upstream.status}` });
  }

  const headers = new Headers(CORS);
  headers.set("Content-Type", audio.mimeType.split(";")[0] || "audio/webm");
  const len = upstream.headers.get("content-length");
  if (len) headers.set("Content-Length", len);
  headers.set("Accept-Ranges", "bytes");
  headers.set("Cache-Control", "no-store");

  return new Response(upstream.body, { status: upstream.status, headers });
}

interface PlayerResponse {
  playabilityStatus?: { status?: string; reason?: string };
  streamingData?: { adaptiveFormats?: AdaptiveFormat[] };
}

// Innertube web client — the same endpoint the YouTube web player uses.
const INNERTUBE_KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";

async function fetchPlayerResponse(videoId: string): Promise<PlayerResponse> {
  const res = await fetch(
    `https://www.youtube.com/youtubei/v1/player?key=${INNERTUBE_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        videoId,
        context: {
          client: {
            clientName: "WEB",
            clientVersion: "2.20240101.00.00",
          },
        },
      }),
    },
  );
  if (!res.ok) throw new Error(`innertube ${res.status}`);
  return res.json();
}

function pickBestAudio(formats: AdaptiveFormat[]): AdaptiveFormat | null {
  const audio = formats.filter((f) => f.mimeType.startsWith("audio/"));
  if (audio.length === 0) return null;
  // Prefer formats with a direct URL, then highest bitrate.
  audio.sort((a, b) => {
    const au = a.url ? 1 : 0;
    const bu = b.url ? 1 : 0;
    if (au !== bu) return bu - au;
    return (b.bitrate ?? 0) - (a.bitrate ?? 0);
  });
  return audio[0];
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}
