// Audio acquisition. Two paths, one output (an ArrayBuffer ready to decode):
//
//   1. Local file  — drag/drop or picker. Works fully offline, today.
//   2. YouTube URL — calls the /api/audio edge function, which resolves the
//      audio stream server-side and re-serves the bytes (the browser can't
//      fetch googlevideo.com directly). Any user-supplied YouTube credentials
//      ride along as headers so the resolver can pass the bot challenge.
import { ytStreamHeaders } from "./auth";

export function parseYouTubeId(input: string): string | null {
  const trimmed = input.trim();
  // Bare 11-char id.
  if (/^[\w-]{11}$/.test(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed);
    if (url.hostname === "youtu.be") {
      const id = url.pathname.slice(1);
      return /^[\w-]{11}$/.test(id) ? id : null;
    }
    if (url.hostname.endsWith("youtube.com")) {
      const v = url.searchParams.get("v");
      if (v && /^[\w-]{11}$/.test(v)) return v;
      // /shorts/<id>, /embed/<id>
      const m = url.pathname.match(/\/(?:shorts|embed)\/([\w-]{11})/);
      if (m) return m[1];
    }
  } catch {
    /* not a URL */
  }
  return null;
}

export async function fileToArrayBuffer(file: File): Promise<ArrayBuffer> {
  return file.arrayBuffer();
}

export interface FetchProgress {
  receivedBytes: number;
  totalBytes: number | null;
}

/**
 * Fetch decodable audio bytes for a YouTube video via the edge proxy.
 * Streams the response so the UI can show download progress.
 */
export async function fetchYouTubeAudio(
  videoId: string,
  onProgress?: (p: FetchProgress) => void,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  // One transient (server 5xx / dropped-stream) retry so a single flaky resolve doesn't
  // wedge the deck in a stuck "fail" state. The edge already retries the player resolve
  // and re-resolves a dead stream URL mid-flight; on its FIRST success it caches the
  // track to R2, so this retry almost always lands on the warm cache. A user abort or a
  // 4xx (genuinely unplayable) is NOT retried.
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await fetchYouTubeAudioOnce(videoId, onProgress, signal);
    } catch (e) {
      lastErr = e;
      if (signal?.aborted || (e as { name?: string })?.name === "AbortError") throw e;
      // TransientAudioError (a clean 5xx from the edge) OR a raw network-level TypeError
      // ("Failed to fetch") — the latter is what a DESTROYED connection looks like from
      // fetch()'s perspective (no HTTP status at all), which is just as retryable as a
      // 5xx: both mean "the attempt failed for reasons that might not recur," not "this
      // track is genuinely unplayable" (that's a clean 4xx, which stays fatal below).
      const transient = e instanceof TransientAudioError || e instanceof TypeError;
      if (transient && attempt === 0) {
        await new Promise((r) => setTimeout(r, 350));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

// A retryable failure (server 5xx or a stream that broke mid-transfer). A 4xx is a
// genuine "not playable" and stays fatal.
class TransientAudioError extends Error {}

async function fetchYouTubeAudioOnce(
  videoId: string,
  onProgress?: (p: FetchProgress) => void,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  const res = await fetch(`/api/audio?v=${encodeURIComponent(videoId)}`, {
    signal,
    headers: await ytStreamHeaders(),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    const msg = `Audio fetch failed (${res.status})${detail ? `: ${detail}` : ""}`;
    throw res.status >= 500 ? new TransientAudioError(msg) : new Error(msg);
  }
  if (!res.body) return res.arrayBuffer();

  const totalBytes = Number(res.headers.get("content-length")) || null;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      receivedBytes += value.byteLength;
      onProgress?.({ receivedBytes, totalBytes });
    }
  } catch (e) {
    // The stream broke mid-transfer (edge re-resolve exhausted, or a network blip) — a
    // retry of the whole fetch will pick up the now-cached track.
    if (signal?.aborted || (e as { name?: string })?.name === "AbortError") throw e;
    throw new TransientAudioError(`Audio stream interrupted: ${(e as Error).message}`);
  }
  const out = new Uint8Array(receivedBytes);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out.buffer;
}
