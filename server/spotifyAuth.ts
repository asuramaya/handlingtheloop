// Spotify OAuth 2.0 (Authorization Code) — links a Spotify account to an existing
// htl user for playlist read/write. Pure-JS fetch; runs in the Worker.
import type { TokenSet } from "./db";

const AUTH_URL = "https://accounts.spotify.com/authorize";
const TOKEN_URL = "https://accounts.spotify.com/api/token";
const ME_URL = "https://api.spotify.com/v1/me";

// Read both playlist visibilities + write to public/private playlists (the sync
// destination). Kept to the minimum sync needs.
const SCOPES = [
  "playlist-read-private",
  "playlist-read-collaborative",
  "playlist-modify-public",
  "playlist-modify-private",
].join(" ");

const TIMEOUT_MS = 8000;

export interface SpotifyCreds {
  clientId: string;
  clientSecret: string;
}
export function spotifyCreds(env?: { SPOTIFY_CLIENT_ID?: string; SPOTIFY_CLIENT_SECRET?: string }): SpotifyCreds | null {
  if (!env?.SPOTIFY_CLIENT_ID || !env?.SPOTIFY_CLIENT_SECRET) return null;
  return { clientId: env.SPOTIFY_CLIENT_ID.trim(), clientSecret: env.SPOTIFY_CLIENT_SECRET.trim() };
}

export function spotifyAuthUrl(clientId: string, redirectUri: string, state: string): string {
  const q = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: SCOPES,
    state,
    show_dialog: "false",
  });
  return `${AUTH_URL}?${q.toString()}`;
}

interface SpotifyTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

// Spotify wants the client id/secret as HTTP Basic on the token endpoint.
function basicAuth(creds: SpotifyCreds): string {
  return `Basic ${btoa(`${creds.clientId}:${creds.clientSecret}`)}`;
}

function toTokenSet(j: SpotifyTokenResponse): TokenSet {
  return {
    access_token: j.access_token!,
    refresh_token: j.refresh_token,
    expires_at: j.expires_in ? Date.now() + j.expires_in * 1000 : undefined,
    scope: j.scope,
  };
}

export async function spotifyExchange(creds: SpotifyCreds, code: string, redirectUri: string): Promise<TokenSet> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", authorization: basicAuth(creds) },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri }).toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const j = (await res.json()) as SpotifyTokenResponse;
  if (!res.ok || !j.access_token) throw new Error(j.error_description || j.error || `spotify token ${res.status}`);
  const tokens = toTokenSet(j);
  // Tag the connection with the Spotify user id (handy for display / API calls).
  try {
    const me = await fetch(ME_URL, {
      headers: { authorization: `Bearer ${tokens.access_token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (me.ok) tokens.provider_user_id = ((await me.json()) as { id?: string }).id;
  } catch {
    /* non-fatal */
  }
  return tokens;
}

export async function spotifyRefresh(creds: SpotifyCreds, refreshToken: string): Promise<TokenSet> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", authorization: basicAuth(creds) },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }).toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const j = (await res.json()) as SpotifyTokenResponse;
  if (!res.ok || !j.access_token) throw new Error(j.error_description || j.error || `spotify refresh ${res.status}`);
  return toTokenSet(j);
}
