// Resolve a usable access token for a user's connected service: decrypt it from
// D1, and transparently refresh it (persisting the new one) when it's expired.
// Used by the SaaS library/sync routes so callers never touch raw tokens.
import { type D1Database, type Provider, getConnection, saveConnection } from "./db";
import { oauthCreds } from "./oauth";
import { googleRefresh } from "./googleAuth";
import { spotifyCreds, spotifyRefresh } from "./spotifyAuth";
import { tidalCreds, tidalRefresh } from "./tidalAuth";

// Structural env (matches AccountEnv) — declared here to avoid an import cycle.
export interface ConnEnv {
  DB: D1Database;
  TOKEN_ENC_KEY?: string;
  GOOGLE_OAUTH_CLIENT_ID?: string;
  GOOGLE_OAUTH_CLIENT_SECRET?: string;
  SPOTIFY_CLIENT_ID?: string;
  SPOTIFY_CLIENT_SECRET?: string;
  TIDAL_CLIENT_ID?: string;
  TIDAL_CLIENT_SECRET?: string;
}

const SKEW_MS = 60_000; // refresh a minute early to avoid edge expiries mid-request

/** The user's `provider` connection with a guaranteed-valid access token (refreshing if needed),
 *  or null if unlinked. Returns the WHOLE connection so a caller that also needs `providerUserId`
 *  doesn't re-read it from D1 (the playlist routes used to fetch the connection twice per call). */
export async function getValidConnection(env: ConnEnv, userId: string, provider: Provider) {
  if (!env.TOKEN_ENC_KEY) throw new Error("TOKEN_ENC_KEY is not configured");
  const encKey = env.TOKEN_ENC_KEY.trim();
  const conn = await getConnection(env.DB, userId, provider, encKey);
  if (!conn) return null;

  const stillValid = conn.expiresAt != null && conn.expiresAt - SKEW_MS > Date.now();
  if (stillValid || !conn.refreshToken) return conn;

  // Expired (or unknown expiry) + we have a refresh token → mint a fresh one.
  const tokens =
    provider === "google"
      ? await googleRefresh(oauthCreds(env), conn.refreshToken)
      : provider === "tidal"
        ? await refreshTidal(env, conn.refreshToken)
        : await refreshSpotify(env, conn.refreshToken);
  await saveConnection(
    env.DB,
    userId,
    provider,
    { ...tokens, provider_user_id: conn.providerUserId ?? undefined },
    encKey,
  );
  return { ...conn, accessToken: tokens.access_token };
}

/** A valid access token for the user's `provider` connection, or null if unlinked. */
export async function getValidToken(env: ConnEnv, userId: string, provider: Provider): Promise<string | null> {
  return (await getValidConnection(env, userId, provider))?.accessToken ?? null;
}

const YT_WRITE_SCOPE = "https://www.googleapis.com/auth/youtube";

/** Whether a space-separated scope string carries the full youtube (write) scope.
 *  Exact-token match — `youtube.readonly` must NOT count as write. */
export function hasYouTubeWriteScope(scope: string | null | undefined): boolean {
  return !!scope && scope.split(/\s+/).includes(YT_WRITE_SCOPE);
}

/** True if the user's Google connection was granted the write scope. Sign-in only
 *  grants youtube.readonly; write is added on demand via the incremental-auth
 *  upgrade (`/api/auth/google/start?write=1`). Callers gate playlist writes on this. */
export async function googleHasYouTubeWrite(env: ConnEnv, userId: string): Promise<boolean> {
  if (!env.TOKEN_ENC_KEY) throw new Error("TOKEN_ENC_KEY is not configured");
  const conn = await getConnection(env.DB, userId, "google", env.TOKEN_ENC_KEY.trim());
  return hasYouTubeWriteScope(conn?.scope);
}

async function refreshSpotify(env: ConnEnv, refreshToken: string) {
  const creds = spotifyCreds(env);
  if (!creds) throw new Error("Spotify is not configured");
  return spotifyRefresh(creds, refreshToken);
}

async function refreshTidal(env: ConnEnv, refreshToken: string) {
  const creds = tidalCreds(env);
  if (!creds) throw new Error("TIDAL is not configured");
  return tidalRefresh(creds, refreshToken);
}
