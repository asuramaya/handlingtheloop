// Catalog / discovery routes: search, the auto-mix "what plays next" feed, the TIDAL probe,
// ISRC features, acoustic identify, and playlist browse. Split verbatim out of the old switch.
import {
  type Env,
  type ExecutionContext,
  cleanVideoTitle,
  fetchPlaylist,
  getMyPlaylists,
  getWatchNext,
  isVideoId,
  json,
  readAuth,
  searchYouTube,
  sessionUser,
} from "../shared";
import { type TrackMeta } from "../../server/youtube";
import { recommendNext } from "../../server/recommend";
import { featuresByIsrc, isrcForMbid } from "../../server/features";
import { acoustidLookup } from "../../server/acoustid";
import { getValidToken } from "../../server/connections";
import { getTidalTrackRadio, tidalTrackIdByIsrc, searchTidalTracks, tidalProbe } from "../../server/tidalData";
import { tidalClientToken, tidalClientTokenDebug, tidalCreds } from "../../server/tidalAuth";
import { upsertAnalysis, getIdentity, upsertIdentity } from "../../server/db";
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
      // "What plays after this track" — the auto-mix / radio suggestion feed.
      const v = url.searchParams.get("v");
      if (!isVideoId(v)) return json(400, { error: "missing or invalid ?v=" });
      const limit = Number(url.searchParams.get("limit")) || 30;
      const provider = url.searchParams.get("provider");
      const a = readAuth(req);
      const seedIsrc = url.searchParams.get("isrc");
      const seedTitle = url.searchParams.get("title");
      // Tier A — TIDAL track radio (music-aware). Find the seed on TIDAL (by ISRC if
      // we have one, else by name — a YouTube seed has no ISRC), pull its similar
      // tracks, and resolve each back to a videoId via search. Uses the app
      // (client-credentials) token, so no user login needed. Fail-soft → YouTube floor.
      let providerRadio: (() => Promise<TrackMeta[]>) | undefined;
      if (seedIsrc || seedTitle) {
        providerRadio = async () => {
          const user = env.DB ? await sessionUser(req, env) : null;
          const token = (user ? await getValidToken(env, user.id, "tidal") : null) ?? (await tidalClientToken(tidalCreds(env)));
          if (!token) return [];
          let tid = seedIsrc ? await tidalTrackIdByIsrc(token, seedIsrc) : null;
          if (!tid && seedTitle) {
            // Match by NAME, but strip the YouTube-title junk first ("(1080p) || HD",
            // "Official Video", …) — the raw uploader title never matches a catalog.
            const q = cleanVideoTitle(seedTitle) || seedTitle;
            const hits = await searchTidalTracks(token, q, 1);
            tid = hits[0]?.id ?? null;
          }
          if (!tid) return [];
          const radio = await getTidalTrackRadio(token, tid, 12);
          const resolved = await Promise.all(
            radio.slice(0, 8).map(async (t) => {
              try {
                const hits = await searchYouTube(`${t.artist} ${t.title}`.trim(), 1);
                const hit = hits[0];
                if (!hit?.videoId) return null;
                return { ...hit, title: t.title || hit.title, artist: t.artist || hit.artist, isrc: t.isrc, provider: "tidal" } as TrackMeta;
              } catch {
                return null;
              }
            }),
          );
          return resolved.filter((x): x is TrackMeta => !!x);
        };
      }
      const candidates = await recommendNext({ getWatchNext }, v, { provider, limit, providerRadio }, { token: a?.accessToken });
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
