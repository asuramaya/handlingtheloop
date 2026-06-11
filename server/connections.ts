// Resolve a usable access token for a user's connected service: decrypt it from
// D1, and transparently refresh it (persisting the new one) when it's expired.
// Used by the SaaS library/sync routes so callers never touch raw tokens.
import { type D1Database, type Provider, getConnection, saveConnection } from "./db";
import { oauthCreds } from "./oauth";
import { googleRefresh } from "./googleAuth";
import { spotifyCreds, spotifyRefresh } from "./spotifyAuth";

// Structural env (matches AccountEnv) — declared here to avoid an import cycle.
export interface ConnEnv {
  DB: D1Database;
  TOKEN_ENC_KEY?: string;
  GOOGLE_OAUTH_CLIENT_ID?: string;
  GOOGLE_OAUTH_CLIENT_SECRET?: string;
  SPOTIFY_CLIENT_ID?: string;
  SPOTIFY_CLIENT_SECRET?: string;
}

const SKEW_MS = 60_000; // refresh a minute early to avoid edge expiries mid-request

/** A valid access token for the user's `provider` connection, or null if unlinked. */
export async function getValidToken(env: ConnEnv, userId: string, provider: Provider): Promise<string | null> {
  if (!env.TOKEN_ENC_KEY) throw new Error("TOKEN_ENC_KEY is not configured");
  const encKey = env.TOKEN_ENC_KEY.trim();
  const conn = await getConnection(env.DB, userId, provider, encKey);
  if (!conn) return null;

  const stillValid = conn.expiresAt != null && conn.expiresAt - SKEW_MS > Date.now();
  if (stillValid || !conn.refreshToken) return conn.accessToken;

  // Expired (or unknown expiry) + we have a refresh token → mint a fresh one.
  const tokens =
    provider === "google"
      ? await googleRefresh(oauthCreds(env), conn.refreshToken)
      : await refreshSpotify(env, conn.refreshToken);
  await saveConnection(
    env.DB,
    userId,
    provider,
    { ...tokens, provider_user_id: conn.providerUserId ?? undefined },
    encKey,
  );
  return tokens.access_token;
}

async function refreshSpotify(env: ConnEnv, refreshToken: string) {
  const creds = spotifyCreds(env);
  if (!creds) throw new Error("Spotify is not configured");
  return spotifyRefresh(creds, refreshToken);
}
