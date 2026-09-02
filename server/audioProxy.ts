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
  // Fires once with the COMPLETE bytes after a full, non-aborted download — lets the
  // caller cache to disk (dev) / R2 (prod) without this module knowing about storage.
  // Never called on an aborted or failed stream, so a truncated/partial track can never
  // poison the cache.
  onComplete?: (bytes: Buffer, contentType: string) => void | Promise<void>,
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
  const parts: Buffer[] = [];
  req.on("close", () => (aborted = true));
  try {
    for await (const chunk of audioChunks(resolved, () => resolveAudio(videoId, auth))) {
      if (aborted) break;
      const buf = Buffer.from(chunk);
      bytes += buf.byteLength;
      if (onComplete) parts.push(buf);
      res.write(buf);
    }
    res.end();
    if (!aborted && onComplete) void onComplete(Buffer.concat(parts), resolved.contentType);
  } catch (e) {
    console.error(`[audio ${videoId}] stream failed after ${bytes} bytes: ${(e as Error)?.stack ?? e}`);
    // Setting res.statusCode/setHeader above does NOT flush anything to the socket —
    // that only happens on the first res.write()/res.end(). So if the very first
    // audioChunks() yield throws (e.g. the initial range fetch 403s) and bytes===0,
    // nothing has actually reached the client yet: we can still send a REAL error
    // response instead of just killing the connection. Getting this right matters —
    // a bare res.destroy() here makes the client's fetch() throw a raw network-level
    // TypeError ("Failed to fetch") instead of resolving with a non-ok Response, which
    // BYPASSES fetchYouTubeAudio's retry logic entirely (it only retries a proper 5xx
    // status, not a generic thrown TypeError) — so a transient failure here previously
    // got zero retries and surfaced as an uncaught rejection all the way up through
    // React's event dispatcher. A clean 502 fixes that: it becomes a TransientAudioError
    // client-side and gets the SAME one-retry treatment a resolve() failure already had.
    if (bytes === 0 && !res.headersSent) {
      res.statusCode = 502;
      res.setHeader("Content-Type", "text/plain");
      // Overwrite, don't just add — the success-path Content-Length above (the full
      // track's expected size) is still set on `res` at this point since nothing
      // flushed it yet, and it would otherwise claim a length far larger than this
      // short error body (ERR_CONTENT_LENGTH_MISMATCH client-side — hit this directly
      // while verifying the fix).
      const body = `stream failed: ${(e as Error)?.message ?? e}`;
      res.setHeader("Content-Length", String(Buffer.byteLength(body)));
      res.end(body);
      return;
    }
    // Mid-stream failure (some bytes already sent) — no way to un-send a partial 200,
    // so dropping the connection is the only honest option here.
    res.destroy(e as Error);
    return;
  }
  const dt = Date.now() - t0;
  console.error(
    `[audio ${videoId}] itag ${resolved.itag} ${bytes} bytes in ${dt}ms ` +
      `(${(bytes / 1e6 / (dt / 1000) || 0).toFixed(1)} MB/s)`,
  );
}
