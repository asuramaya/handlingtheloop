// Community-pool + crowdsourced-data routes: the shared cache browse, session invite minting,
// metadata/analysis contributions, and the shared stem cache. Split verbatim out of the switch.
import {
  type Env,
  type ExecutionContext,
  MAX_STEM_BYTES,
  NO_CACHE,
  STEM_NAMES,
  isVideoId,
  json,
  sessionUser,
  stemCachedIds,
} from "../shared";
import { type TrackMeta } from "../../server/youtube";
import { listCommunityTracks, upsertCommunityTrack, getOrCreateInvite, getAnalysisByIds, getAnalysisFull, upsertAnalysis } from "../../server/db";
import {
  STEM_DOWNLOAD_CONTENT_TYPE,
  DOWNLOAD_SAFE_HEADERS,
  allow,
  clampNum,
  cleanText,
  clientIp,
  looksLikeAudioStem,
  sanitizeHttpUrl,
} from "../../server/security";

export async function handleCommunityRoutes(url: URL, req: Request, env: Env, ctx: ExecutionContext): Promise<Response | null> {
  switch (url.pathname) {
    case "/api/community": {
      // The shared cache, surfaced as a browsable pool. PRIMARY path: the D1
      // index (ordered, paginated, O(limit)). FALLBACK: scan R2 directly — used
      // pre-migration or before the one-time reindex has populated D1.
      const limit = Math.min(Number(url.searchParams.get("limit")) || 60, 5000);
      // The Library/Search cache badges ask for a per-track stems flag; the plain
      // pool browse omits it so it stays a single indexed query (no R2 walk).
      const stemIds = url.searchParams.get("stems") === "1" ? await stemCachedIds(env) : null;

      if (env.DB) {
        try {
          const rows = await listCommunityTracks(env.DB, limit);
          if (rows.length) {
            return json(200, {
              tracks: rows.map((t) => ({
                ...t,
                thumbnail: t.thumbnail || `https://i.ytimg.com/vi/${t.videoId}/hqdefault.jpg`,
                views: null,
                ...(stemIds ? { stems: stemIds.has(t.videoId) } : {}),
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
            ...(stemIds ? { stems: stemIds.has(v) } : {}),
          });
        }
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor && tracks.length < 5000);
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
      // GET ?v=<id>&full=1 → the FULL stored analysis for one track (incl. serialized grid +
      // algorithm version) — the cache-first load reads this to reuse a grid instead of re-deriving.
      if (req.method === "GET" && url.searchParams.get("full")) {
        const v = url.searchParams.get("v") || "";
        if (!isVideoId(v)) return json(400, { error: "bad videoId" });
        if (!env.DB) return json(200, { analysis: null });
        const row = await getAnalysisFull(env.DB, v);
        return json(
          200,
          {
            analysis: row
              ? { bpm: row.bpm, key: row.music_key, keyName: row.key_name, beatOffset: row.beat_offset, duration: row.duration, grid: row.grid, version: row.version }
              : null,
          },
          // A stored grid is deterministic for a (video, version) pair — let the browser hold it.
          { "cache-control": "public, max-age=300" },
        );
      }
      // GET ?ids=v1,v2 → known BPM/key for a batch (auto-mix candidate scoring).
      if (req.method === "GET") {
        const ids = (url.searchParams.get("ids") || "").split(",").map((s) => s.trim()).filter(Boolean);
        if (!ids.length) return json(400, { error: "missing ?ids=" });
        if (!env.DB) return json(200, { analysis: {} });
        const rows = await getAnalysisByIds(env.DB, ids);
        const analysis: Record<string, { bpm: number | null; key: string | null }> = {};
        for (const r of rows) analysis[r.video_id] = { bpm: r.bpm, key: r.music_key };
        return json(200, { analysis });
      }
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
        grid?: string;
        version?: number;
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
            // Full serialized beatgrid — bounded (anonymous, HF-bound). A ~10-min track's grid is
            // a few KB; 256 KB is a generous ceiling that rejects any absurd/oversized payload.
            grid: typeof b.grid === "string" && b.grid.length > 0 && b.grid.length <= 262_144 ? b.grid : null,
            // Algorithm version — drives the don't-downgrade convergence guard in upsertAnalysis.
            // Clamp to a sane integer; absent/garbage falls to the DB default (1).
            version: Number.isInteger(b.version) && b.version! >= 1 && b.version! <= 1_000_000 ? b.version : undefined,
          }).catch(() => {}),
        );
      }
      return json(200, { ok: true });
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
    default:
      return null;
  }
}
