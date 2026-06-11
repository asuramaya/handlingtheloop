// Account + connected-service HTTP routes (the SaaS layer), shared by the Worker.
// Returns a Response for any /api/auth/* or /api/me route it owns, else null so
// the main router can continue. Requires D1 (DB) + Google web-OAuth creds +
// TOKEN_ENC_KEY in the environment.
import { oauthCreds } from "./oauth";
import { googleAuthUrl, googleExchange } from "./googleAuth";
import { spotifyAuthUrl, spotifyCreds, spotifyExchange } from "./spotifyAuth";
import { getValidToken } from "./connections";
import { fetchPlaylistData, getMyPlaylistsData } from "./ytdata";
import { getMySpotifyPlaylists } from "./spotifyData";
import {
  type D1Database,
  createSession,
  deleteConnection,
  deleteSession,
  getUserSettings,
  listConnections,
  putUserSettings,
  saveConnection,
  upsertGoogleUser,
  userBySession,
} from "./db";
import {
  SESSION_TTL_MS,
  clearSessionCookie,
  clearStateCookie,
  randomToken,
  readSessionId,
  readState,
  sessionCookie,
  stateCookie,
} from "./session";

export interface AccountEnv {
  DB: D1Database;
  GOOGLE_OAUTH_CLIENT_ID?: string;
  GOOGLE_OAUTH_CLIENT_SECRET?: string;
  SPOTIFY_CLIENT_ID?: string;
  SPOTIFY_CLIENT_SECRET?: string;
  TOKEN_ENC_KEY?: string;
}

function json(status: number, body: unknown, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });
}
const redirect = (location: string, headers?: HeadersInit) =>
  new Response(null, { status: 302, headers: { location, ...headers } });

async function currentUser(env: AccountEnv, req: Request) {
  if (!env.DB) return null;
  const sid = readSessionId(req);
  return sid ? userBySession(env.DB, sid) : null;
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

  switch (path) {
    // Kick off Google sign-in: set a CSRF state cookie, bounce to Google.
    case "/api/auth/google/start": {
      requireEnv(env);
      const state = randomToken(16);
      return redirect(googleAuthUrl(oauthCreds(env).clientId, googleRedirectUri, state), {
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
        user: { id: user.id, email: user.email, name: user.name, avatar: user.avatar },
        connections,
      });
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
        const ts = typeof body.updatedAt === "number" ? body.updatedAt : Date.now();
        await putUserSettings(env.DB, user.id, JSON.stringify(body.data), ts);
        return json(200, { ok: true, updatedAt: ts });
      }
      return json(405, { error: "GET or PUT only" });
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
      if (provider !== "google" && provider !== "spotify") return json(400, { error: "bad provider" });
      await deleteConnection(env.DB, user.id, provider);
      return json(200, { ok: true });
    }

    default:
      return null; // not ours
  }
}
