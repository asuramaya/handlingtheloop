// Audio acquisition. Two paths, one output (an ArrayBuffer ready to decode):
//
//   1. Local file  — drag/drop or picker. Works fully offline, today.
//   2. YouTube URL — calls the /api/audio edge function, which resolves the
//      audio stream server-side and re-serves the bytes WITH CORS headers
//      (the browser can't fetch googlevideo.com directly). See api/audio.ts.

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
  const res = await fetch(`/api/audio?v=${encodeURIComponent(videoId)}`, {
    signal,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `Audio fetch failed (${res.status})${detail ? `: ${detail}` : ""}`,
    );
  }
  if (!res.body) return res.arrayBuffer();

  const totalBytes = Number(res.headers.get("content-length")) || null;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    receivedBytes += value.byteLength;
    onProgress?.({ receivedBytes, totalBytes });
  }
  const out = new Uint8Array(receivedBytes);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out.buffer;
}
