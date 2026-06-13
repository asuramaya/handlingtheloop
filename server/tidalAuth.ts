// TIDAL OAuth 2.0 (Authorization Code + PKCE) — links a TIDAL account to an htl
// user for playlist read/write. TIDAL mandates PKCE for ALL clients (incl. ones
// with a client secret), so unlike Spotify we carry a code_verifier from the auth
// redirect to the callback (in a short-lived cookie) and send its S256 challenge
// up front. Pure-JS fetch; runs in the Worker.
//
// CREDENTIALS: there is NO public well-known TIDAL client (unlike the YouTube TV
// app), so this is INERT until a registered TIDAL developer app's id/secret are
// provided via `wrangler secret put TIDAL_CLIENT_ID/_SECRET` (tidalCreds → null
// otherwise, and every route 503s cleanly). Register at developer.tidal.com.
//
// API SHAPES TO VERIFY: the OAuth endpoints + PKCE requirement are from TIDAL's
// docs; the exact scope strings below are a best-effort set and should be checked
// against the live developer portal when a key is added.
import type { TokenSet } from "./db";

const AUTH_URL = "https://login.tidal.com/authorize";
const TOKEN_URL = "https://auth.tidal.com/v1/oauth2/token";
const ME_URL = "https://openapi.tidal.com/v2/users/me";

// Scopes for reading + writing the user's playlists/collection. TIDAL's portal is
// the source of truth for the exact strings — adjust if a grant is rejected.
const SCOPES = ["user.read", "collection.read", "collection.write", "playlists.read", "playlists.write"].join(" ");

const TIMEOUT_MS = 8000;
const FORM = { "content-type": "application/x-www-form-urlencoded" };

export interface TidalCreds {
  clientId: string;
  clientSecret: string;
}
export function tidalCreds(env?: { TIDAL_CLIENT_ID?: string; TIDAL_CLIENT_SECRET?: string }): TidalCreds | null {
  if (!env?.TIDAL_CLIENT_ID || !env?.TIDAL_CLIENT_SECRET) return null;
  return { clientId: env.TIDAL_CLIENT_ID.trim(), clientSecret: env.TIDAL_CLIENT_SECRET.trim() };
}

// --- PKCE -------------------------------------------------------------------
function base64url(bytes: ArrayBuffer | Uint8Array): string {
  const a = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of a) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A fresh PKCE code_verifier (43–128 chars, URL-safe). */
export function pkceVerifier(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(48)));
}

/** The S256 challenge for a verifier (base64url of its SHA-256). */
export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(digest);
}

/** The URL we redirect the user to. `state` is echoed back for CSRF checking. */
export function tidalAuthUrl(clientId: string, redirectUri: string, state: string, codeChallenge: string): string {
  const q = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: SCOPES,
    state,
    code_challenge_method: "S256",
    code_challenge: codeChallenge,
  });
  return `${AUTH_URL}?${q.toString()}`;
}

interface TidalTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  user_id?: string | number;
  error?: string;
  error_description?: string;
}

function toTokenSet(j: TidalTokenResponse): TokenSet {
  return {
    access_token: j.access_token!,
    refresh_token: j.refresh_token,
    expires_at: j.expires_in ? Date.now() + j.expires_in * 1000 : undefined,
    scope: j.scope,
    provider_user_id: j.user_id != null ? String(j.user_id) : undefined,
  };
}

/** Exchange the callback `code` (+ stored PKCE verifier) for tokens. */
export async function tidalExchange(
  creds: TidalCreds,
  code: string,
  redirectUri: string,
  codeVerifier: string,
): Promise<TokenSet> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: FORM,
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: creds.clientId,
      client_secret: creds.clientSecret, // confidential app — TIDAL accepts it alongside PKCE
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    }).toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const j = (await res.json()) as TidalTokenResponse;
  if (!res.ok || !j.access_token) throw new Error(j.error_description || j.error || `tidal token ${res.status}`);
  const tokens = toTokenSet(j);
  // Backfill the user id from /users/me if the token response didn't carry it
  // (needed to scope the user's playlists).
  if (!tokens.provider_user_id) {
    try {
      const me = await fetch(ME_URL, {
        headers: { authorization: `Bearer ${tokens.access_token}`, accept: "application/vnd.api+json" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (me.ok) {
        const mj = (await me.json()) as { data?: { id?: string } };
        if (mj.data?.id) tokens.provider_user_id = mj.data.id;
      }
    } catch {
      /* non-fatal */
    }
  }
  return tokens;
}

/** Exchange a stored refresh_token for a fresh access_token. */
export async function tidalRefresh(creds: TidalCreds, refreshToken: string): Promise<TokenSet> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: FORM,
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      refresh_token: refreshToken,
    }).toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const j = (await res.json()) as TidalTokenResponse;
  if (!res.ok || !j.access_token) throw new Error(j.error_description || j.error || `tidal refresh ${res.status}`);
  return toTokenSet(j);
}
