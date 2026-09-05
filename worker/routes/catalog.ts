// Catalog / discovery routes: search, the auto-mix "what plays next" feed, the TIDAL probe,
// ISRC features, acoustic identify, and playlist browse. Split verbatim out of the old switch.
import {
  type Env,
  type ExecutionContext,
  fetchPlaylist,
  getMyPlaylists,
  getWatchNext,
  getMusicRadio,
  isVideoId,
  json,
  readAuth,
  searchYouTube,
  sessionUser,
} from "../shared";
import { recommendNext } from "../../server/recommend";
import { featuresByIsrc, isrcForMbid } from "../../server/features";
import { acoustidLookup } from "../../server/acoustid";
import { getValidToken } from "../../server/connections";
import { tidalProbe } from "../../server/tidalData";
import { makeProviderRadio } from "../../server/providerRadio";
import { tidalClientToken, tidalClientTokenDebug, tidalCreds } from "../../server/tidalAuth";
import { upsertAnalysis, getIdentity, upsertIdentity, getIsrcVideos, putIsrcVideos } from "../../server/db";
import { allow } from "../../server/security";

export async function handleCatalogRoutes(url: URL, req: Request, env: Env, ctx: ExecutionContext): Promise<Response | null> {
  switch (url.pathname) {
    case "/api/search": {
      const q = url.searchParams.get("q")?.trim();
      if (!q) return json(400, { error: "missing ?q=" });
      const limit = Number(url.searchParams.get("limit")) || 25;
      return json(200, { results: await searchYouTube(q, limit) });
    }
    case "/api/recommend": {
      // "What plays after this track" — the auto-mix / radio suggestion feed. Three tiers, best
      // first, each allowed to fail: TIDAL track radio → YouTube Music radio → watch-next spine.
      // See server/recommend.ts for why they are in that order.
      const v = url.searchParams.get("v");
      if (!isVideoId(v)) return json(400, { error: "missing or invalid ?v=" });
      const limit = Number(url.searchParams.get("limit")) || 30;
      const provider = url.searchParams.get("provider");
      const a = readAuth(req);
      // Tier A. A user's linked TIDAL token if there is one, else the app (client-credentials)
      // token — catalogue reads need no login. Resolutions are memoised in D1 permanently: an
      // ISRC names a specific recording forever, and the search-per-result this replaces was
      // costing up to two dozen subrequests on a single fill.
      const providerRadio = makeProviderRadio(
        { isrc: url.searchParams.get("isrc"), title: url.searchParams.get("title"), artist: url.searchParams.get("artist") },
        {
          token: async () => {
            const user = env.DB ? await sessionUser(req, env) : null;
            return (user ? await getValidToken(env, user.id, "tidal") : null) ?? (await tidalClientToken(tidalCreds(env)));
          },
          searchYouTube: (q, n) => searchYouTube(q, n),
          cache: env.DB
            ? {
                get: async (isrcs) =>
                  new Map(
                    (await getIsrcVideos(env.DB, isrcs)).map((r) => [r.isrc, { videoId: r.video_id, title: r.title ?? "", artist: r.artist ?? "" }]),
                  ),
                put: (rows) => putIsrcVideos(env.DB, rows),
              }
            : undefined,
        },
      );
      const candidates = await recommendNext({ getWatchNext, getMusicRadio }, v, { provider, limit, providerRadio }, { token: a?.accessToken });
      return json(200, { candidates });
    }
    case "/api/tidal-probe": {
      // TEMP DIAGNOSTIC — verify TIDAL track-radio works with your live token.
      // Visit /api/tidal-probe?q=artist+title (or ?isrc=) while signed in + TIDAL linked.
      const isrc = url.searchParams.get("isrc");
      const q = url.searchParams.get("q");
      if (!isrc && !q) return json(400, { error: "pass ?q=artist+title or ?isrc=" });
      // Prefer a linked user token; else fall back to a client-credentials app
      // token (catalog reads need no login — just TIDAL_CLIENT_ID/SECRET).
      const user = await sessionUser(req, env);
      let token = user ? await getValidToken(env, user.id, "tidal") : null;
      let tokenKind = token ? "user" : "";
      if (!token) {
        token = await tidalClientToken(tidalCreds(env));
        tokenKind = token ? "client_credentials" : "";
      }
      if (!token) {
        // Surface WHY the app token failed (blank creds vs Tidal rejection + reason).
        const tokenDebug = await tidalClientTokenDebug(tidalCreds(env));
        return json(200, { hasToken: false, tokenDebug, hint: "see tokenDebug: hasCreds=false → fill .dev.vars; status 401 → bad id/secret; 400 → grant/scope not enabled for the app" });
      }
      return json(200, { hasToken: true, tokenKind, ...(await tidalProbe(token, { isrc, query: q })) });
    }
    case "/api/features": {
      // Key/BPM for a track by ISRC (free public DBs) — auto-mix candidate scoring.
      const isrc = url.searchParams.get("isrc");
      if (!isrc) return json(400, { error: "missing ?isrc=" });
      const f = await featuresByIsrc(isrc);
      // Cache to the shared dataset keyed by videoId when we know it.
      const v = url.searchParams.get("v");
      if (f && (f.bpm != null || f.key != null) && v && isVideoId(v) && env.DB) {
        ctx.waitUntil(upsertAnalysis(env.DB, { videoId: v, bpm: f.bpm, key: f.key }).catch(() => {}));
      }
      return json(200, { features: f });
    }
    case "/api/identify": {
      // Acoustic identity: a Chromaprint fingerprint → canonical recording (ISRC +
      // clean artist/title). GLOBALLY CACHED in D1 so AcoustID is queried at most
      // once per track, ever (don't leech); rate-capped for novel tracks; fail-soft
      // to no-match so the caller falls back to cleaned-title.
      if (req.method !== "POST") return json(405, { error: "POST only" });
      const b = (await req.json().catch(() => ({}))) as { videoId?: string; fingerprint?: string; duration?: number };
      if (!isVideoId(b.videoId ?? null)) return json(400, { error: "bad videoId" });
      const videoId = b.videoId!;
      // 1) Global cache — return immediately if this track was ever identified.
      //    A no-match (source:"none") is cached too, so we don't re-query it.
      if (env.DB) {
        const cached = await getIdentity(env.DB, videoId).catch(() => null);
        if (cached) {
          const id = cached.source === "none" ? null : { isrc: cached.isrc, mbid: cached.mbid, artist: cached.artist, title: cached.title };
          return json(200, { identity: id, cached: true });
        }
      }
      // No fingerprint = a cache probe (lets the client skip decoding when another
      // user already identified the track). Cache miss → tell it to fingerprint.
      if (!b.fingerprint) return json(200, { identity: null, needsFingerprint: true });
      if (!env.ACOUSTID_API_KEY) return json(200, { identity: null, reason: "no_key" });
      if (!b.duration) return json(400, { error: "missing duration" });
      // 2) Throttle novel lookups so we never exceed AcoustID's free tier.
      if (!(await allow(env.RL_ACOUSTID, "acoustid"))) return json(200, { identity: null, throttled: true });
      // 3) Fingerprint → MusicBrainz recording → ISRC (the global id).
      const match = await acoustidLookup(env.ACOUSTID_API_KEY, b.fingerprint, b.duration);
      const isrc = match?.mbid ? await isrcForMbid(match.mbid) : null;
      const identity = match
        ? { isrc, mbid: match.mbid, artist: match.artist, title: match.title }
        : { isrc: null, mbid: null, artist: null, title: null };
      // 4) Cache the result (even a no-match, so we don't re-query unidentifiable uploads).
      if (env.DB) {
        ctx.waitUntil(
          upsertIdentity(env.DB, { videoId, isrc: identity.isrc, mbid: identity.mbid, artist: identity.artist, title: identity.title, source: match ? "acoustid" : "none" }).catch(() => {}),
        );
      }
      return json(200, { identity: match ? identity : null });
    }
    case "/api/playlist": {
      const raw = url.searchParams.get("list") ?? url.searchParams.get("url");
      if (!raw) return json(400, { error: "missing ?list=" });
      let listId = raw;
      if (/^https?:/.test(raw)) {
        try {
          listId = new URL(raw).searchParams.get("list") ?? raw;
        } catch {
          /* keep raw */
        }
      }
      const a = readAuth(req);
      return json(200, await fetchPlaylist(listId, { token: a?.accessToken }));
    }
    case "/api/me/playlists": {
      // The signed-in user's own playlists (private included). Browse is driven
      // by an OAuth token — required (the legacy cookie path was removed).
      const a = readAuth(req);
      if (!a?.accessToken) return json(401, { error: "connect YouTube first" });
      return json(200, { playlists: await getMyPlaylists({ token: a.accessToken }) });
    }
    default:
      return null;
  }
}
