import type { IncomingMessage, ServerResponse } from "node:http";
import { audioChunks, resolveAudio, type YtAuth } from "./youtube";

// Node (dev-server) audio handler. Resolves the stream with the pure-JS
// ANDROID_VR resolver and relays it to the browser in chunked ranges. The exact
// same resolveAudio/audioChunks run unchanged in the Cloudflare Worker
// (worker/index.ts) — this file is just the Node plumbing around them.

export async function streamAudio(
  req: IncomingMessage,
  res: ServerResponse,
  videoId: string,
  auth?: YtAuth,
): Promise<void> {
  let resolved;
  try {
    resolved = await resolveAudio(videoId, auth);
  } catch (e) {
    res.statusCode = 502;
    res.end(`resolve failed: ${(e as Error).message}`);
    return;
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", resolved.contentType);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (resolved.contentLength) res.setHeader("Content-Length", String(resolved.contentLength));

  const t0 = Date.now();
  let bytes = 0;
  let aborted = false;
  req.on("close", () => (aborted = true));
  try {
    for await (const chunk of audioChunks(resolved.url, resolved.contentLength)) {
      if (aborted) break;
      bytes += chunk.byteLength;
      res.write(Buffer.from(chunk));
    }
    res.end();
  } catch (e) {
    // Headers already sent — just drop the connection.
    res.destroy(e as Error);
    return;
  }
  const dt = Date.now() - t0;
  console.error(
    `[audio ${videoId}] itag ${resolved.itag} ${bytes} bytes in ${dt}ms ` +
      `(${(bytes / 1e6 / (dt / 1000) || 0).toFixed(1)} MB/s)`,
  );
}
