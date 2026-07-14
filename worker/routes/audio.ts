// Audio + media routes: the cold-load resolver/cache, the cold-load diagnostic, single-track
// metadata, captions, and the community-pooled lyrics. Split verbatim out of the old index.ts
// switch — same behaviour, just grouped. Returns null when the path isn't one of these.
import {
  type Env,
  type ExecutionContext,
  MAX_CACHE_BYTES,
  NO_CACHE,
  isVideoId,
  json,
  readAuth,
  sessionUser,
} from "../shared";
import { audioChunks, diagnoseAudio, diagnoseRelay, fetchCaptions, fetchMeta, makeRelayFetch, resolveAudio, type Fetcher } from "../../server/youtube";
import { upsertCommunityTrack, getCachedCaptions, putCachedCaptions, getLyrics, putLyrics } from "../../server/db";
import { allow, clientIp, cleanText, clampNum, sniffImage } from "../../server/security";

// Where a pooled transcript's WORDS came from. "aligned"/"estimated"/"lrclib" = a real lyrics
// database + our own timing. The Whisper ids are gone: they produced INVENTED words, and rows
// carrying them are refused on read (see getLyrics) rather than ranked.
const LYRIC_SOURCES = ["aligned", "estimated", "lrclib"];

// Fetch a video's thumbnail from YouTube's CDN, best resolution first. hqdefault always exists;
// maxresdefault is higher-res but 404s (or returns a tiny placeholder) for some uploads.
async function fetchYtThumb(id: string): Promise<ArrayBuffer | null> {
  for (const q of ["maxresdefault", "hqdefault"]) {
    try {
      const r = await fetch(`https://i.ytimg.com/vi/${id}/${q}.jpg`);
      if (r.ok) {
        const b = await r.arrayBuffer();
        if (b.byteLength > 2048) return b; // reject the 120×90 "no maxres" placeholder
      }
    } catch {
      /* try the next resolution */
    }
  }
  return null;
}

// Cloudflare's identity TransformStream carrying a known Content-Length — lets us hand R2 a
// streaming body (a tee branch) for a streamed put without buffering the whole track in RAM.
// It's a runtime GLOBAL in the Workers environment (ambient only — `declare class` emits no
// value, so it's never imported; the bundler resolves `new FixedLengthStream` to the global).
declare class FixedLengthStream {
  constructor(length: number);
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
}

export async function handleAudioRoutes(url: URL, req: Request, env: Env, ctx: ExecutionContext): Promise<Response | null> {
  // Same-origin album art (R2-cached). YouTube thumbnails are cross-origin (i.ytimg.com), which
  // (a) leaks the viewer's IP to Google on every render and (b) blocks the COEP `require-corp`
  // upgrade the stem pager needs. Serve the art first-party instead: fetch-on-miss from ytimg, sniff
  // the bytes, store in R2, and serve through the edge Cache API (nosniff, immutable) — the same
  // template as the avatar serve. Being same-origin, the art is also canvas-UNTAINTED → the client
  // can extract a colour palette from it (per-track theming). Prefix route → matched before the switch.
  if (url.pathname.startsWith("/api/art/")) {
    if (!env.AUDIO) return new Response(null, { status: 404 });
    const v = url.pathname.slice("/api/art/".length).replace(/[^\w-]/g, "");
    if (!isVideoId(v)) return new Response(null, { status: 404 });
    const edge = (globalThis as { caches?: { default?: { match(r: Request): Promise<Response | undefined>; put(r: Request, resp: Response): Promise<void> } } }).caches?.default;
    const cacheKey = new Request(url.toString());
    if (edge) {
      const hit = await edge.match(cacheKey);
      if (hit) return hit;
    }
    let body: ArrayBuffer | null = null;
    const stored = await env.AUDIO.get(`art/${v}`);
    if (stored) body = await stored.arrayBuffer();
    else {
      body = await fetchYtThumb(v); // cold: pull it from ytimg once, then it's ours
      if (body) ctx.waitUntil(env.AUDIO.put(`art/${v}`, body, { httpMetadata: { contentType: sniffImage(new Uint8Array(body.slice(0, 12))) ?? "image/jpeg" } }));
    }
    if (!body) return new Response(null, { status: 404 });
    const ct = sniffImage(new Uint8Array(body.slice(0, 12))) ?? "image/jpeg"; // never trust a stored/fetched type
    const resp = new Response(body, {
      status: 200,
      headers: { "content-type": ct, "x-content-type-options": "nosniff", "cache-control": "public, max-age=604800, immutable" },
    });
    if (edge) ctx.waitUntil(edge.put(cacheKey, resp.clone()));
    return resp;
  }
  switch (url.pathname) {
    case "/api/audio/diag": {
      const v = url.searchParams.get("v");
      if (!isVideoId(v)) return json(400, { error: "missing or invalid ?v=" });
      // Auth-gate the diagnostic: it fires real YouTube requests and reports the egress IP +
      // client cascade, so it's not for anonymous hits (YouTube-budget burn + info disclosure).
      // No client calls this — only a signed-in operator hits it in a browser to debug cold loads.
      if (!(await sessionUser(req, env))) return json(401, { error: "sign in to run diagnostics" });
      if (!(await allow(env.RL_AUDIO, clientIp(req)))) return json(429, { error: "rate limited — try again shortly" });
      const diag = await diagnoseAudio(v, readAuth(req));
      // ?relay=1 → ALSO force a resolve + byte-probe through the residential relay, so an operator
      // can prove the whole chain (worker → Access → tunnel → fgb → YouTube) on demand, without
      // waiting for the datacenter egress to actually be bot-walled. `relay.resolve.ok === true`
      // is definitive (makeRelayFetch has no direct fallback — success means every hop is healthy).
      if (url.searchParams.get("relay")) {
        const relayAccess =
          env.CF_ACCESS_CLIENT_ID && env.CF_ACCESS_CLIENT_SECRET
            ? { clientId: env.CF_ACCESS_CLIENT_ID, clientSecret: env.CF_ACCESS_CLIENT_SECRET }
            : undefined;
        const relay = env.YT_RELAY_URL && env.YT_RELAY_SECRET ? makeRelayFetch(env.YT_RELAY_URL, env.YT_RELAY_SECRET, relayAccess) : null;
        diag.relay = relay
          ? await diagnoseRelay(v, readAuth(req), relay, !!relayAccess)
          : { configured: false, accessConfigured: !!relayAccess };
      }
      return json(200, diag);
    }
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
      let r;
      let via: Fetcher | undefined; // the fetcher that resolved — reused for the byte stream
      let usedRelay = false; // observability: did this cold load fall through to the residential relay?
      try {
        r = await resolveAudio(v, readAuth(req));
      } catch (e) {
        // Datacenter egress is bot-walled for this cold track. If a residential relay is
        // configured (YT_RELAY_*), retry the resolve — and, below, the byte stream — through
        // it; its IP isn't flagged. BOTH hops go via the relay so googlevideo's IP-lock holds.
        const relayAccess =
          env.CF_ACCESS_CLIENT_ID && env.CF_ACCESS_CLIENT_SECRET
            ? { clientId: env.CF_ACCESS_CLIENT_ID, clientSecret: env.CF_ACCESS_CLIENT_SECRET }
            : undefined;
        const relay = env.YT_RELAY_URL && env.YT_RELAY_SECRET ? makeRelayFetch(env.YT_RELAY_URL, env.YT_RELAY_SECRET, relayAccess) : null;
        if (!relay) {
          return json(502, { error: "could not load from YouTube", reason: e instanceof Error ? e.message : String(e) });
        }
        try {
          r = await resolveAudio(v, readAuth(req), relay);
          via = relay;
          usedRelay = true;
          // Visible in `wrangler tail` — this is the ONLY signal that the residential relay
          // actually fired in production (it only fires on the cold-miss tail when the
          // datacenter egress is bot-walled). The served response also carries x-htl-via: relay.
          console.log(`[htl] relay served ${v} — datacenter egress was bot-walled (${e instanceof Error ? e.message : String(e)})`);
        } catch (e2) {
          return json(502, { error: "could not load from YouTube", reason: e2 instanceof Error ? e2.message : String(e2) });
        }
      }

      // Track metadata for the R2 object (lifted from the same player response, no extra
      // request) so the Community list renders names + thumbnails from one R2 list() call.
      const customMetadata = r.meta
        ? {
            title: r.meta.title.slice(0, 256),
            artist: r.meta.artist.slice(0, 128),
            duration: String(r.meta.duration),
            thumbnail: r.meta.thumbnail.slice(0, 400),
          }
        : undefined;

      // Oversized track (> MAX_CACHE_BYTES): stream to the listener AND cache to R2 at the same
      // time, WITHOUT buffering the whole track in Worker RAM (the worker's ~128 MB ceiling is
      // why big tracks used to skip the cache → the relay re-fired on EVERY play). `tee()` splits
      // the source: one branch streams to the listener, the other feeds a streaming R2 put via a
      // FixedLengthStream (R2 needs a known length for a stream put — we have it from
      // contentLength). The listener is the slow consumer (network-bound); R2 (in-region) drains
      // its branch faster, so the tee never backpressures playback. Now ANY size caches on first
      // play → the relay still fires at most once per track, ever.
      if (r.contentLength > MAX_CACHE_BYTES) {
        const source = new ReadableStream<Uint8Array>({
          async start(controller) {
            try {
              for await (const chunk of audioChunks(r, () => resolveAudio(v, readAuth(req), via), via)) controller.enqueue(chunk);
              controller.close();
            } catch (e) {
              controller.error(e);
            }
          },
        });
        const [toUser, toR2] = source.tee();
        // Cache in the background, best-effort. A length mismatch (e.g. a mid-stream re-resolve)
        // or any R2 error rejects the put and pipeTo cancels its branch — `toUser` is independent,
        // so playback is never affected. The put completes even if the listener disconnects.
        const fls = new FixedLengthStream(r.contentLength);
        ctx.waitUntil(
          Promise.all([
            toR2.pipeTo(fls.writable).catch(() => {}),
            env.AUDIO.put(key, fls.readable, { httpMetadata: { contentType: r.contentType }, customMetadata }).catch(() => {}),
          ]),
        );
        if (env.DB && r.meta) {
          ctx.waitUntil(
            upsertCommunityTrack(env.DB, { videoId: v, title: r.meta.title, artist: r.meta.artist, duration: r.meta.duration, thumbnail: r.meta.thumbnail }).catch(() => {}),
          );
        }
        const h: Record<string, string> = { "content-type": r.contentType, "x-content-type-options": "nosniff", "x-htl-cache": "miss", "x-htl-via": usedRelay ? "relay" : "direct", ...NO_CACHE };
        h["content-length"] = String(r.contentLength);
        return new Response(toUser, { headers: h });
      }

      // Buffer the whole track, return to the user, and cache to R2 in the
      // background (waitUntil) so it doesn't delay playback.
      const parts: Uint8Array[] = [];
      let total = 0;
      for await (const chunk of audioChunks(r, () => resolveAudio(v, readAuth(req), via), via)) {
        parts.push(chunk);
        total += chunk.byteLength;
      }
      const buf = new Uint8Array(total);
      let off = 0;
      for (const p of parts) {
        buf.set(p, off);
        off += p.byteLength;
      }
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
          "x-htl-via": usedRelay ? "relay" : "direct",
          ...NO_CACHE,
        },
      });
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
    case "/api/lyrics": {
      // Community-pooled Whisper transcripts — the PRIMARY lyrics source. GET serves the
      // best transcript on file (instant, works on phones); POST is a desktop GPU
      // contributing what it decoded so the next device gets it free. Best-effort, no
      // auth — same posture as /api/analysis (facts about the recording, not the bytes).
      const v = url.searchParams.get("v");
      if (req.method === "GET") {
        if (!isVideoId(v)) return json(400, { error: "missing or invalid ?v=" });
        if (!env.DB) return json(200, { transcript: null });
        const row = await getLyrics(env.DB, v).catch(() => null);
        if (!row) return json(200, { transcript: null });
        return json(200, {
          // `ver` is the transcript-FORMAT version that produced these lines. The client compares
          // it against its own LYRICS_VER: behind → re-decode and upgrade the row; at-or-ahead →
          // reuse as-is. Without it the pool would keep serving a stale format forever.
          transcript: { v: 1, videoId: v, model: row.model, lang: row.lang, source: "pool", conf: row.conf, ver: row.ver, lines: row.lines, createdAt: 0 },
        });
      }
      if (req.method === "POST") {
        if (!(await allow(env.RL_WRITE, clientIp(req)))) return json(429, { error: "rate limited" });
        const b = (await req.json().catch(() => ({}))) as { videoId?: string; model?: string; lang?: string; conf?: number; ver?: number; lines?: unknown };
        if (!isVideoId(b.videoId ?? null)) return json(400, { error: "bad videoId" });
        // ★ DO NOT COERCE THE PROVENANCE. This was `b.model === "small" ? "small" : "base"` — a
        // hardcoded Whisper-era whitelist that silently RELABELLED anything it didn't recognise. So
        // every row the new pipeline posted ("aligned") landed in the pool stamped "base", i.e. as a
        // Whisper hallucination. A field that quietly rewrites what it's told is worse than no field:
        // it doesn't lose the provenance, it INVERTS it.
        const model = LYRIC_SOURCES.includes(b.model ?? "") ? (b.model as string) : "aligned";
        // Transcript-format version (client LYRICS_VER). Bounded so a poster can't claim an absurd
        // version to make their row permanently un-overwritable by the don't-downgrade guard.
        const ver = Math.max(1, Math.min(100, Math.floor(Number(b.ver) || 1)));
        // Shape-validate + bound the payload so no anonymous poster can store garbage or an
        // oversized blob: {start,end,text, words?:[{t,w}]} clamped, capped at 2000 lines /
        // 40 words. The optional per-word timings drive the karaoke highlight.
        const clampT = (n: number) => Math.max(0, Math.min(86_400, n));
        const raw = Array.isArray(b.lines) ? (b.lines as unknown[]) : [];
        const lines = raw
          .filter((l): l is { start: number; end: number; text: string; words?: unknown } => {
            const o = l as { start?: unknown; end?: unknown; text?: unknown };
            return typeof o?.start === "number" && typeof o?.end === "number" && typeof o?.text === "string";
          })
          .slice(0, 2000)
          .map((l) => {
            const base = { start: clampT(l.start), end: clampT(l.end), text: cleanText(l.text, 200) };
            const wr = Array.isArray(l.words) ? (l.words as unknown[]) : null;
            const words = wr
              ? wr
                  .filter((x): x is { t: number; w: string; d?: number } => {
                    const o = x as { t?: unknown; w?: unknown };
                    return typeof o?.t === "number" && typeof o?.w === "string";
                  })
                  .slice(0, 40)
                  .map((x) => ({ t: clampT(x.t), w: cleanText(x.w, 40), d: typeof x.d === "number" ? Math.max(0, Math.min(60, x.d)) : 0 }))
                  .filter((x) => x.w.length > 0)
              : [];
            return words.length ? { ...base, words } : base;
          })
          .filter((l) => l.text.length > 0);
        if (!lines.length) return json(400, { error: "no valid lines" });
        // Loop-hallucination guard. Whisper's classic failure on an instrumental passage is to emit
        // ONE phrase over and over; that transcript is worthless and, once pooled, it is served to
        // every other device. A transcript whose every line is the same text is never real lyrics.
        // (The client gates harder before contributing — this is the backstop for any poster.)
        if (lines.length >= 4 && new Set(lines.map((l) => l.text.toLowerCase())).size === 1) {
          return json(400, { error: "rejected: degenerate transcript" });
        }
        if (env.DB) {
          ctx.waitUntil(
            putLyrics(env.DB, {
              videoId: b.videoId!,
              model,
              // "und" (undetermined) is the honest default: the decoder AUTO-detects language and
              // does not report it back, so anything else here would be a guess stored as fact.
              lang: cleanText(b.lang ?? "und", 8) || "und",
              conf: clampNum(b.conf, 0, 1) ?? 0,
              ver,
              lines,
              contributor: null,
            }).catch(() => {}),
          );
        }
        return json(200, { ok: true });
      }
      return json(405, { error: "GET or POST only" });
    }
    default:
      return null;
  }
}
