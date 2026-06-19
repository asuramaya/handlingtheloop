// Account + connected-service HTTP routes (the SaaS layer), shared by the Worker.
// Returns a Response for any /api/auth/* or /api/me route it owns, else null so
// the main router can continue. Requires D1 (DB) + Google web-OAuth creds +
// TOKEN_ENC_KEY in the environment.
import { json, redirect } from "./http";
import { oauthCreds } from "./oauth";
import { googleAuthUrl, googleExchange } from "./googleAuth";
import { spotifyAuthUrl, spotifyCreds, spotifyExchange } from "./spotifyAuth";
import { pkceChallenge, pkceVerifier, tidalAuthUrl, tidalCreds, tidalExchange, tidalScopes } from "./tidalAuth";
import { getValidToken, getValidConnection } from "./connections";
import { fetchPlaylistData, getMyPlaylistsData } from "./ytdata";
import { getMySpotifyPlaylists } from "./spotifyData";
import { getMyTidalPlaylists } from "./tidalData";
import {
  type D1Database,
  type R2Bucket,
  type User,
  type SetRow,
  type SetTrack,
  createSession,
  createSet,
  deleteSet,
  ensureSetsTable,
  getSet,
  setsByHost,
  setSetStatus,
  setSetTitle,
  deleteConnection,
  deleteSession,
  announceRoom,
  blockUser,
  closeRoom,
  ensureGraphTables,
  ensureIdentityColumns,
  ensureReportsTable,
  ensureRoomsTable,
  fileReport,
  recentReportCount,
  followCounts,
  liveRooms,
  liveRoomStatus,
  followUser,
  followersOf,
  followingOf,
  getTopTracks,
  getUserSettings,
  handleTaken,
  relationship,
  unblockUser,
  unfollowUser,
  userByHandle,
  listConnections,
  logUserPlay,
  putUserSettings,
  saveConnection,
  setUserHandle,
  updateProfile,
  upsertGoogleUser,
  userBySession,
} from "./db";
import { cleanText, clientIp, foldHandle, sanitizeHttpUrl, validateHandle } from "./security";
import {
  SESSION_TTL_MS,
  clearPkceCookie,
  clearSessionCookie,
  clearStateCookie,
  pkceCookie,
  randomToken,
  readPkce,
  readSessionId,
  readState,
  sessionCookie,
  stateCookie,
} from "./session";

export interface AccountEnv {
  DB: D1Database;
  AUDIO?: R2Bucket; // R2 bucket — stores recorded-set recipe logs (G1) alongside the audio cache
  GOOGLE_OAUTH_CLIENT_ID?: string;
  GOOGLE_OAUTH_CLIENT_SECRET?: string;
  SPOTIFY_CLIENT_ID?: string;
  SPOTIFY_CLIENT_SECRET?: string;
  TIDAL_CLIENT_ID?: string;
  TIDAL_CLIENT_SECRET?: string;
  TIDAL_SCOPES?: string; // optional override of the requested TIDAL OAuth scopes
  TOKEN_ENC_KEY?: string;
  // DEV-ONLY: when set (a .dev.vars secret, NEVER a production secret), enables the
  // /api/auth/dev shortcut login so the DO/social features are testable under
  // `pnpm worker` without the Google OAuth round-trip. Absent in prod → route 404s.
  DEV_LOGIN?: string;
}

async function currentUser(env: AccountEnv, req: Request) {
  if (!env.DB) return null;
  const sid = readSessionId(req);
  return sid ? userBySession(env.DB, sid) : null;
}

/** The PUBLIC face of an account: the user-owned handle/display fields, falling
 *  back to the Google-mirror only as a private seed (never the email). Used for
 *  any surface a peer could see. `handle` is null until the user claims one. */
function publicIdentity(u: User) {
  return {
    handle: u.handle ?? null,
    displayName: u.display_name ?? u.name ?? null,
    avatar: u.avatar_url ?? u.avatar ?? null,
    bio: u.bio ?? null,
  };
}

// --- Recorded sets (G1) helpers -------------------------------------------
const MAX_SET_BYTES = 12 * 1024 * 1024; // a recipe is commands-only; 12 MB covers very long sets

function clampInt(v: unknown, lo: number, hi: number): number {
  const n = Math.floor(Number(v) || 0);
  return Math.max(lo, Math.min(hi, n));
}

/** Validate one captured tracklist marker (untrusted client input). */
function sanitizeTrack(t: unknown): SetTrack | null {
  if (!t || typeof t !== "object") return null;
  const o = t as Record<string, unknown>;
  if (typeof o.videoId !== "string" || !/^[\w-]{11}$/.test(o.videoId)) return null;
  return {
    videoId: o.videoId,
    title: cleanText(String(o.title ?? ""), 200) || null,
    artist: cleanText(String(o.artist ?? ""), 120) || null,
    at: clampInt(o.at, 0, 24 * 3600_000),
  };
}

/** A `sets` row → the JSON card the client reads (tracklist parsed; host identity is
 *  joined in by the public-list routes, G1d). */
function setCard(row: SetRow) {
  let tracklist: SetTrack[] = [];
  try {
    tracklist = row.tracklist ? (JSON.parse(row.tracklist) as SetTrack[]) : [];
  } catch {
    /* corrupt tracklist → empty */
  }
  return {
    id: row.id,
    title: row.title,
    genre: row.genre,
    status: row.status,
    duration: row.duration,
    tracks: row.tracks,
    tracklist,
    coverVideo: row.coverVideo,
    engineVer: row.engineVer,
    createdAt: row.createdAt,
    publishedAt: row.publishedAt,
  };
}

function requireEnv(env: AccountEnv): string {
  if (!env.DB) throw new Error("D1 binding DB is not configured");
  if (!env.GOOGLE_OAUTH_CLIENT_ID || !env.GOOGLE_OAUTH_CLIENT_SECRET) {
    throw new Error("Google OAuth is not configured (set GOOGLE_OAUTH_CLIENT_ID/_SECRET)");
  }
  if (!env.TOKEN_ENC_KEY) throw new Error("TOKEN_ENC_KEY is not configured");
  return env.TOKEN_ENC_KEY.trim();
}

export async function handleAccountRoute(url: URL, req: Request, env: AccountEnv): Promise<Response | null> {
  const path = url.pathname;
  const googleRedirectUri = `${url.origin}/api/auth/google/callback`;

  // PUBLIC profile by handle — no auth, and PUBLIC fields only (never email or
  // connections). Dynamic path, so it's matched before the exact-path switch.
  if (path.startsWith("/api/u/")) {
    if (!env.DB) return json(404, { error: "not found" });
    await ensureIdentityColumns(env.DB);
    await ensureGraphTables(env.DB);
    const folded = foldHandle(decodeURIComponent(path.slice("/api/u/".length)));
    const u = folded ? await userByHandle(env.DB, folded) : null;
    if (!u || !u.handle) return json(404, { error: "no such handle" });
    const viewer = await currentUser(env, req);
    // A blocker can't see the blockee's profile (and vice-versa) — treat as absent.
    if (viewer && (await relationship(env.DB, viewer.id, u.id)).blockedBy) {
      return json(404, { error: "no such handle" });
    }
    await ensureRoomsTable(env.DB);
    const [topTracks, counts, live] = await Promise.all([
      getTopTracks(env.DB, u.id, 12),
      followCounts(env.DB, u.id),
      liveRoomStatus(env.DB, u.id),
    ]);
    const rel = viewer && viewer.id !== u.id ? await relationship(env.DB, viewer.id, u.id) : null;
    return json(200, {
      handle: u.handle,
      // PUBLIC: never fall back to the Google legal name (B7). Unset display name →
      // null, and the UI shows the @handle instead. Same for the Google avatar.
      displayName: u.display_name ?? null,
      avatar: u.avatar_url ?? null,
      bio: u.bio ?? null,
      memberSince: u.created_at,
      topTracks,
      counts,
      live: live.live, // broadcasting right now?
      liveListeners: live.listeners,
      isSelf: !!viewer && viewer.id === u.id,
      relationship: rel, // null when signed out or viewing self
    });
  }

  // A recorded set by id (G1): GET the card / `?log=1` recipe blob (G1c replay), or the
  // owner lifecycle mutations (G1b) — POST <id>/publish | <id>/unpublish | <id>/rename,
  // DELETE <id>. Drafts are private to their host. Dynamic path → matched before the exact
  // switch, like /api/u/ above.
  if (path.startsWith("/api/sets/")) {
    if (!env.DB) return json(404, { error: "not found" });
    await ensureSetsTable(env.DB);
    const rest = path.slice("/api/sets/".length);
    const slash = rest.indexOf("/");
    const id = slash === -1 ? rest : rest.slice(0, slash);
    const action = slash === -1 ? "" : rest.slice(slash + 1);
    if (!id) return json(404, { error: "no such set" });
    const row = await getSet(env.DB, id);
    if (!row) return json(404, { error: "no such set" });

    // Lifecycle mutations — owner only (the host_id guard in the model double-enforces).
    if (req.method !== "GET") {
      const viewer = await currentUser(env, req);
      if (!viewer || viewer.id !== row.hostId) return json(403, { error: "not your set" });
      if (req.method === "DELETE" && action === "") {
        await deleteSet(env.DB, id, viewer.id);
        try {
          await env.AUDIO?.delete?.(`sets/${id}.json`);
        } catch {
          /* blob already gone — the row is what mattered */
        }
        return json(200, { ok: true });
      }
      if (req.method === "POST" && (action === "publish" || action === "unpublish")) {
        await setSetStatus(env.DB, id, viewer.id, action === "publish" ? "published" : "draft");
        return json(200, { ok: true });
      }
      if (req.method === "POST" && action === "rename") {
        const b = (await req.json().catch(() => ({}))) as { title?: string };
        await setSetTitle(env.DB, id, viewer.id, cleanText(b.title ?? "", 120) || null);
        return json(200, { ok: true });
      }
      return json(405, { error: "bad method" });
    }

    // GET — the card, or the recipe blob. Drafts are owner-private.
    if (row.status !== "published") {
      const viewer = await currentUser(env, req);
      if (!viewer || viewer.id !== row.hostId) return json(404, { error: "no such set" });
    }
    if (url.searchParams.get("log") === "1") {
      const obj = env.AUDIO ? await env.AUDIO.get(`sets/${id}.json`) : null;
      if (!obj) return json(404, { error: "log unavailable" });
      return new Response(await obj.text(), { headers: { "content-type": "application/json" } });
    }
    return json(200, { set: setCard(row) });
  }

  switch (path) {
    // Kick off Google sign-in: set a CSRF state cookie, bounce to Google.
    // `?write=1` requests the full youtube (manage) scope — the on-demand upgrade
    // triggered when a user first pushes a sync INTO YouTube. Plain sign-in is
    // read-only (see googleAuth.ts). include_granted_scopes makes the upgrade add
    // write to the existing grant rather than replace it.
    case "/api/auth/google/start": {
      requireEnv(env);
      const write = url.searchParams.get("write") === "1";
      const state = randomToken(16);
      return redirect(googleAuthUrl(oauthCreds(env).clientId, googleRedirectUri, state, write), {
        "set-cookie": stateCookie(state),
      });
    }

    // Google redirects back here with ?code & ?state.
    case "/api/auth/google/callback": {
      const encKey = requireEnv(env);
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const expected = readState(req);
      if (url.searchParams.get("error")) return redirect(`/?auth_error=${url.searchParams.get("error")}`);
      if (!code || !state || !expected || state !== expected) {
        return redirect("/?auth_error=bad_state", { "set-cookie": clearStateCookie() });
      }
      const { tokens, profile } = await googleExchange(oauthCreds(env), code, googleRedirectUri);
      const user = await upsertGoogleUser(env.DB, profile);
      await saveConnection(env.DB, user.id, "google", { ...tokens, provider_user_id: profile.sub }, encKey);
      const sid = randomToken(32);
      await createSession(env.DB, user.id, sid, SESSION_TTL_MS);
      // Land back in the app, signed in. Clear the one-shot state cookie.
      const headers = new Headers({ location: "/" });
      headers.append("set-cookie", sessionCookie(sid));
      headers.append("set-cookie", clearStateCookie());
      return new Response(null, { status: 302, headers });
    }

    // Current account + which services are linked (200 with user:null when signed out).
    case "/api/me": {
      if (!env.DB) return json(200, { user: null, connections: [] });
      const sid = readSessionId(req);
      const user = sid ? await userBySession(env.DB, sid) : null;
      if (!user) return json(200, { user: null, connections: [] });
      const connections = await listConnections(env.DB, user.id);
      return json(200, {
        // email stays here (own-account view only); the public bits come via publicIdentity.
        user: { id: user.id, email: user.email, name: user.name, ...publicIdentity(user) },
        connections,
      });
    }

    // Handle availability check (sign-in gated to bound enumeration). ?h=<handle>.
    case "/api/handle/check": {
      const user = await currentUser(env, req);
      if (!user) return json(401, { error: "sign in first" });
      await ensureIdentityColumns(env.DB);
      const v = validateHandle(url.searchParams.get("h"));
      if (!v.ok) return json(200, { available: false, reason: v.reason });
      const taken = await handleTaken(env.DB, v.folded, user.id);
      return json(200, { available: !taken, handle: v.handle, reason: taken ? "taken" : undefined });
    }

    // Claim (or rename) the signed-in user's @handle.
    case "/api/me/handle": {
      if (req.method !== "POST") return json(405, { error: "POST only" });
      const user = await currentUser(env, req);
      if (!user) return json(401, { error: "sign in first" });
      await ensureIdentityColumns(env.DB);
      const b = (await req.json().catch(() => ({}))) as { handle?: string };
      const v = validateHandle(b.handle);
      if (!v.ok) return json(400, { error: v.reason });
      // No-op rename to the same handle the user already holds — succeed quietly.
      if (user.handle && foldHandle(user.handle) === v.folded) return json(200, { handle: user.handle });
      const res = await setUserHandle(env.DB, user.id, v.handle, v.folded);
      if (!res.ok) return json(409, { error: res.reason === "taken" ? "that handle is taken" : res.reason });
      return json(200, { handle: res.handle });
    }

    // Social graph actions — follow / unfollow / block / unblock another user by
    // handle. All sign-in gated, POST { handle }. Each returns the fresh viewer↔
    // target relationship + the target's counts so the UI updates without a refetch.
    case "/api/follow":
    case "/api/unfollow":
    case "/api/block":
    case "/api/unblock": {
      if (req.method !== "POST") return json(405, { error: "POST only" });
      const user = await currentUser(env, req);
      if (!user) return json(401, { error: "sign in first" });
      await ensureGraphTables(env.DB);
      const b = (await req.json().catch(() => ({}))) as { handle?: string };
      const target = await userByHandle(env.DB, foldHandle(String(b.handle ?? "")));
      if (!target || !target.handle) return json(404, { error: "no such handle" });
      if (target.id === user.id) return json(400, { error: "that's you" });
      if (path === "/api/follow") {
        const r = await followUser(env.DB, user.id, target.id);
        if (!r.ok) return json(409, { error: r.reason });
      } else if (path === "/api/unfollow") {
        await unfollowUser(env.DB, user.id, target.id);
      } else if (path === "/api/block") {
        await blockUser(env.DB, user.id, target.id);
      } else {
        await unblockUser(env.DB, user.id, target.id);
      }
      const [rel, counts] = await Promise.all([
        relationship(env.DB, user.id, target.id),
        followCounts(env.DB, target.id),
      ]);
      return json(200, { ok: true, relationship: rel, counts });
    }

    // Followers / following lists for a handle (public cards; paginated ?offset=).
    // NOT under /api/u/ — that prefix is the public-profile catch above.
    case "/api/followers":
    case "/api/following": {
      if (!env.DB) return json(404, { error: "not found" });
      await ensureGraphTables(env.DB);
      const target = await userByHandle(env.DB, foldHandle(url.searchParams.get("h") ?? ""));
      if (!target || !target.handle) return json(404, { error: "no such handle" });
      const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
      const list =
        path === "/api/followers"
          ? await followersOf(env.DB, target.id, 50, offset)
          : await followingOf(env.DB, target.id, 50, offset);
      return json(200, { list });
    }

    // The live public-room directory (E2). PUBLIC — anyone can browse what's on now.
    case "/api/rooms/live": {
      if (!env.DB) return json(200, { rooms: [] });
      await ensureRoomsTable(env.DB);
      return json(200, { rooms: await liveRooms(env.DB) });
    }

    // HOST announces / heartbeats their live room into the directory (E1). Requires a
    // handle (the room's public address). Called on go-public + periodically while live.
    case "/api/rooms/announce": {
      if (req.method !== "POST") return json(405, { error: "POST only" });
      const user = await currentUser(env, req);
      if (!user) return json(401, { error: "sign in first" });
      await ensureIdentityColumns(env.DB);
      if (!user.handle) return json(400, { error: "claim a handle before going public" });
      await ensureRoomsTable(env.DB);
      const b = (await req.json().catch(() => ({}))) as {
        title?: string;
        genre?: string;
        listeners?: number;
        nowPlaying?: { title?: string; artist?: string; videoId?: string };
      };
      await announceRoom(env.DB, user.id, {
        title: cleanText(b.title ?? "", 80) || null,
        genre: cleanText(b.genre ?? "", 32) || null,
        listeners: Math.max(0, Math.min(1_000_000, Math.floor(Number(b.listeners) || 0))),
        npTitle: cleanText(b.nowPlaying?.title ?? "", 200) || null,
        npArtist: cleanText(b.nowPlaying?.artist ?? "", 120) || null,
        npVideo: /^[\w-]{11}$/.test(b.nowPlaying?.videoId ?? "") ? b.nowPlaying!.videoId! : null,
      });
      return json(200, { ok: true });
    }

    // HOST closes their live room (stopped broadcasting).
    case "/api/rooms/close": {
      if (req.method !== "POST") return json(405, { error: "POST only" });
      const user = await currentUser(env, req);
      if (!user) return json(401, { error: "sign in first" });
      await ensureRoomsTable(env.DB);
      await closeRoom(env.DB, user.id);
      return json(200, { ok: true });
    }

    // HOST persists a captured broadcast recipe as a private draft (G1a). Body = the
    // CapturedSet { engineVersion, duration, log, tracklist, coverVideo }. The log blob goes
    // to R2 (commands only — no audio); this writes the indexed D1 row.
    case "/api/sets": {
      if (req.method !== "POST") return json(405, { error: "POST only" });
      const user = await currentUser(env, req);
      if (!user) return json(401, { error: "sign in first" });
      await ensureIdentityColumns(env.DB);
      if (!user.handle) return json(400, { error: "claim a handle before saving a set" });
      const raw = await req.text();
      if (raw.length > MAX_SET_BYTES) return json(413, { error: "set too large" });
      let body: { engineVersion?: number; duration?: number; log?: unknown; tracklist?: unknown; coverVideo?: unknown };
      try {
        body = JSON.parse(raw);
      } catch {
        return json(400, { error: "bad json" });
      }
      const log = Array.isArray(body.log) ? body.log : [];
      const tracklist = Array.isArray(body.tracklist) ? body.tracklist.slice(0, 500).map(sanitizeTrack).filter(Boolean) : [];
      const duration = clampInt(body.duration, 0, 24 * 3600_000);
      const engineVer = clampInt(body.engineVersion, 0, 9999);
      const coverVideo =
        typeof body.coverVideo === "string" && /^[\w-]{11}$/.test(body.coverVideo)
          ? body.coverVideo
          : ((tracklist[0] as SetTrack | undefined)?.videoId ?? null);
      const logJson = JSON.stringify({ engineVersion: engineVer, duration, log });
      await ensureSetsTable(env.DB);
      const id = await createSet(env.DB, {
        hostId: user.id,
        duration,
        tracklist: tracklist as SetTrack[],
        coverVideo,
        engineVer,
        bytes: logJson.length,
      });
      try {
        await env.AUDIO?.put(`sets/${id}.json`, logJson, { httpMetadata: { contentType: "application/json" } });
      } catch {
        await deleteSet(env.DB, id, user.id); // no blob → no dangling row
        return json(500, { error: "could not store set" });
      }
      return json(200, { id });
    }

    // The signed-in host's own sets (drafts + published), newest first (G1b/G1d).
    case "/api/me/sets": {
      const user = await currentUser(env, req);
      if (!user) return json(401, { error: "sign in first" });
      await ensureSetsTable(env.DB);
      const rows = await setsByHost(env.DB, user.id, true);
      return json(200, { sets: rows.map(setCard) });
    }

    // File a moderation report (L2) — anyone present (incl. anon listeners) can flag a room or
    // a chat message; it lands in the queue the admin worker reads. Anti-flood: ≤20/reporter/hr.
    case "/api/report": {
      if (req.method !== "POST") return json(405, { error: "POST only" });
      await ensureReportsTable(env.DB);
      const b = (await req.json().catch(() => ({}))) as { kind?: string; room?: string; dev?: string; text?: string; reason?: string };
      const kind = b.kind === "room" || b.kind === "chat" || b.kind === "user" ? b.kind : null;
      if (!kind) return json(400, { error: "bad report kind" });
      const user = await currentUser(env, req);
      const reporter = user?.id ?? `anon:${clientIp(req)}`;
      if ((await recentReportCount(env.DB, reporter, Date.now() - 3_600_000)) >= 20) {
        return json(429, { error: "too many reports — try again later" });
      }
      await fileReport(env.DB, {
        kind,
        room: cleanText(b.room ?? "", 32) || null,
        targetDev: cleanText(b.dev ?? "", 64) || null,
        targetText: cleanText(b.text ?? "", 300) || null,
        reporter,
        reason: cleanText(b.reason ?? "", 200) || null,
      });
      return json(200, { ok: true });
    }

    // The signed-in user's full profile: identity + "member since" + top songs. Backs
    // the Profile screen. Own-profile only (peers are device-scoped in the room DO, never
    // linked to an account id, by design).
    case "/api/me/profile": {
      const user = await currentUser(env, req);
      if (!user) return json(401, { error: "sign in first" });
      await ensureIdentityColumns(env.DB);

      // PUT edits the user-owned public fields (display name / bio / avatar URL).
      // Cleaned + length-clamped; the Google-mirror name/avatar are never touched.
      if (req.method === "PUT") {
        const b = (await req.json().catch(() => ({}))) as {
          displayName?: string;
          bio?: string;
          avatarUrl?: string | null;
        };
        const patch: { display_name?: string | null; bio?: string | null; avatar_url?: string | null } = {};
        if (b.displayName !== undefined) patch.display_name = cleanText(b.displayName, 48) || null;
        if (b.bio !== undefined) patch.bio = cleanText(b.bio, 300) || null;
        if (b.avatarUrl !== undefined) patch.avatar_url = b.avatarUrl === null ? null : sanitizeHttpUrl(b.avatarUrl);
        await updateProfile(env.DB, user.id, patch);
        return json(200, { ok: true, ...patch });
      }
      if (req.method !== "GET") return json(405, { error: "GET or PUT only" });

      await ensureGraphTables(env.DB);
      const [topTracks, connections, counts] = await Promise.all([
        getTopTracks(env.DB, user.id, 12),
        listConnections(env.DB, user.id),
        followCounts(env.DB, user.id),
      ]);
      return json(200, {
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          memberSince: user.created_at,
          ...publicIdentity(user),
        },
        connections,
        topTracks,
        counts,
      });
    }

    // Record one play of a track by the signed-in user (feeds the profile's top songs).
    // Fire-and-forget from the client on track load; cheap, idempotent-ish (a counter).
    case "/api/me/play": {
      if (req.method !== "POST") return json(405, { error: "POST only" });
      const user = await currentUser(env, req);
      if (!user) return json(401, { error: "sign in first" });
      const b = (await req.json().catch(() => ({}))) as {
        videoId?: string;
        title?: string;
        artist?: string;
        thumbnail?: string;
      };
      if (!b.videoId || !/^[\w-]{11}$/.test(b.videoId)) return json(400, { error: "bad videoId" });
      await logUserPlay(env.DB, user.id, {
        videoId: b.videoId,
        title: b.title?.slice(0, 256),
        artist: b.artist?.slice(0, 128),
        thumbnail: b.thumbnail?.slice(0, 400),
      });
      return json(200, { ok: true });
    }

    // Cross-device UI settings sync (the @htl Settings blob). GET pulls the stored
    // blob + its timestamp; PUT upserts it. Last-write-wins by the client timestamp,
    // reconciled on the client against its own last-change time.
    case "/api/me/settings": {
      const user = await currentUser(env, req);
      if (!user) return json(401, { error: "sign in first" });
      if (req.method === "GET") {
        const row = await getUserSettings(env.DB, user.id);
        return json(200, { data: row ? JSON.parse(row.data) : null, updatedAt: row?.updated_at ?? 0 });
      }
      if (req.method === "PUT") {
        const body = (await req.json().catch(() => null)) as { data?: unknown; updatedAt?: number } | null;
        if (!body || body.data == null) return json(400, { error: "data required" });
        const serialized = JSON.stringify(body.data);
        // Cap the per-user settings blob so it can't be used to bloat D1.
        if (serialized.length > 256 * 1024) return json(413, { error: "settings too large" });
        const ts = typeof body.updatedAt === "number" ? body.updatedAt : Date.now();
        await putUserSettings(env.DB, user.id, serialized, ts);
        return json(200, { ok: true, updatedAt: ts });
      }
      return json(405, { error: "GET or PUT only" });
    }

    // DEV-ONLY shortcut login. Active ONLY when env.DEV_LOGIN is set — a secret that
    // lives in .dev.vars and is NEVER configured in production, so this route simply
    // doesn't exist there (returns null → 404). Mints a REAL D1 user + session so rooms /
    // graph / broadcast are testable under `pnpm worker` without Google OAuth. `?name=`
    // picks the identity, so different browsers can be different real users (multi-user
    // follow/block/room testing). See DEV.md.
    case "/api/auth/dev": {
      if (!env.DEV_LOGIN) return null; // not configured (incl. all of production) → not our route
      if (!env.DB) return json(503, { error: "D1 not configured" });
      const name = (url.searchParams.get("name") || "Dev").replace(/[^\w .-]/g, "").slice(0, 40) || "Dev";
      const key = name.toLowerCase().replace(/\s+/g, "");
      const user = await upsertGoogleUser(env.DB, { sub: `dev:${key}`, name, email: `${key}@dev.local` });
      const sid = randomToken(32);
      await createSession(env.DB, user.id, sid, SESSION_TTL_MS);
      const headers = new Headers({ location: "/" });
      headers.append("set-cookie", sessionCookie(sid));
      return new Response(null, { status: 302, headers });
    }

    case "/api/auth/logout": {
      if (req.method !== "POST") return json(405, { error: "POST only" });
      const sid = readSessionId(req);
      if (sid && env.DB) await deleteSession(env.DB, sid);
      return json(200, { ok: true }, { "set-cookie": clearSessionCookie() });
    }

    // Link a Spotify account to the signed-in htl user.
    case "/api/auth/spotify/start": {
      const creds = spotifyCreds(env);
      if (!creds) return json(503, { error: "Spotify is not configured" });
      const user = await currentUser(env, req);
      if (!user) return json(401, { error: "sign in first" });
      const state = randomToken(16);
      return redirect(spotifyAuthUrl(creds.clientId, `${url.origin}/api/auth/spotify/callback`, state), {
        "set-cookie": stateCookie(state),
      });
    }

    case "/api/auth/spotify/callback": {
      const creds = spotifyCreds(env);
      if (!creds || !env.TOKEN_ENC_KEY) return redirect("/?connect_error=not_configured");
      const user = await currentUser(env, req);
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const expected = readState(req);
      if (!user) return redirect("/?connect_error=not_signed_in", { "set-cookie": clearStateCookie() });
      if (url.searchParams.get("error") || !code || !state || state !== expected) {
        return redirect("/?connect_error=spotify", { "set-cookie": clearStateCookie() });
      }
      const tokens = await spotifyExchange(creds, code, `${url.origin}/api/auth/spotify/callback`);
      await saveConnection(env.DB, user.id, "spotify", tokens, env.TOKEN_ENC_KEY.trim());
      return redirect("/?connected=spotify", { "set-cookie": clearStateCookie() });
    }

    // Link a TIDAL account (Authorization Code + PKCE). We stash the code_verifier
    // in a short-lived cookie alongside the CSRF state, then exchange both back.
    case "/api/auth/tidal/start": {
      const creds = tidalCreds(env);
      if (!creds) return json(503, { error: "TIDAL is not configured" });
      const user = await currentUser(env, req);
      if (!user) return json(401, { error: "sign in first" });
      const state = randomToken(16);
      const verifier = pkceVerifier();
      const challenge = await pkceChallenge(verifier);
      const headers = new Headers();
      headers.append("set-cookie", stateCookie(state));
      headers.append("set-cookie", pkceCookie(verifier));
      headers.set(
        "location",
        tidalAuthUrl(creds.clientId, `${url.origin}/api/auth/tidal/callback`, state, challenge, tidalScopes(env)),
      );
      return new Response(null, { status: 302, headers });
    }

    case "/api/auth/tidal/callback": {
      const creds = tidalCreds(env);
      const clearAuthCookies = () => {
        const h = new Headers();
        h.append("set-cookie", clearStateCookie());
        h.append("set-cookie", clearPkceCookie());
        return h;
      };
      if (!creds || !env.TOKEN_ENC_KEY) return redirect("/?connect_error=not_configured");
      const user = await currentUser(env, req);
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const verifier = readPkce(req);
      const expected = readState(req);
      if (!user) {
        const h = clearAuthCookies();
        h.set("location", "/?connect_error=not_signed_in");
        return new Response(null, { status: 302, headers: h });
      }
      if (url.searchParams.get("error") || !code || !state || state !== expected || !verifier) {
        const h = clearAuthCookies();
        h.set("location", "/?connect_error=tidal");
        return new Response(null, { status: 302, headers: h });
      }
      const tokens = await tidalExchange(creds, code, `${url.origin}/api/auth/tidal/callback`, verifier);
      await saveConnection(env.DB, user.id, "tidal", tokens, env.TOKEN_ENC_KEY.trim());
      const h = clearAuthCookies();
      h.set("location", "/?connected=tidal");
      return new Response(null, { status: 302, headers: h });
    }

    // The signed-in user's TIDAL playlists.
    case "/api/me/tidal/playlists": {
      const user = await currentUser(env, req);
      if (!user) return json(401, { error: "sign in first" });
      if (!env.TOKEN_ENC_KEY) return json(503, { error: "not configured" });
      // One D1 read: getValidConnection returns the whole connection (valid token + the TIDAL
      // user id stored at link time), so we don't re-fetch the connection just for providerUserId.
      const conn = await getValidConnection(env, user.id, "tidal");
      if (!conn) return json(400, { error: "TIDAL not connected" });
      if (!conn.providerUserId) return json(400, { error: "TIDAL user id unavailable — reconnect TIDAL" });
      return json(200, { playlists: await getMyTidalPlaylists(conn.accessToken, conn.providerUserId) });
    }

    // The signed-in user's YouTube playlists, via their ACCOUNT's Google token
    // (our Data-API-enabled project). Falls through to the legacy cookie/header
    // route only when not signed in.
    case "/api/me/playlists": {
      const user = await currentUser(env, req);
      if (!user) return null;
      const token = await getValidToken(env, user.id, "google");
      if (!token) return json(400, { error: "YouTube not connected" });
      return json(200, { playlists: await getMyPlaylistsData(token) });
    }

    // Importing a YouTube playlist (own or public) while signed in: use the
    // ACCOUNT's Google token (Data-API project) so it doesn't fall through to the
    // dead legacy header token. Not signed in → fall through to the public/cookie
    // route in the worker.
    case "/api/playlist": {
      const user = await currentUser(env, req);
      if (!user) return null;
      const token = await getValidToken(env, user.id, "google");
      if (!token) return null;
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
      return json(200, await fetchPlaylistData(token, listId));
    }

    // The signed-in user's Spotify playlists.
    case "/api/me/spotify/playlists": {
      const user = await currentUser(env, req);
      if (!user) return json(401, { error: "sign in first" });
      const token = await getValidToken(env, user.id, "spotify");
      if (!token) return json(400, { error: "Spotify not connected" });
      return json(200, { playlists: await getMySpotifyPlaylists(token) });
    }

    // Unlink a service. Body: {provider}.
    case "/api/connections/disconnect": {
      if (req.method !== "POST") return json(405, { error: "POST only" });
      const user = await currentUser(env, req);
      if (!user) return json(401, { error: "sign in first" });
      const { provider } = (await req.json().catch(() => ({}))) as { provider?: string };
      if (provider !== "google" && provider !== "spotify" && provider !== "tidal") {
        return json(400, { error: "bad provider" });
      }
      await deleteConnection(env.DB, user.id, provider);
      return json(200, { ok: true });
    }

    default:
      return null; // not ours
  }
}
