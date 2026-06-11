// Google "Web application" OAuth 2.0 (Authorization Code) — htl account sign-in
// AND the YouTube connection in one grant. Distinct from the device-code flow in
// oauth.ts (that one used the public TV creds, which can't reach the Data API);
// this uses OUR registered web app, whose project HAS the YouTube Data API v3
// enabled. Pure-JS fetch; runs in the Worker.
import type { OAuthCreds } from "./oauth";
import type { GoogleProfile, TokenSet } from "./db";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

// openid/email/profile → htl identity; youtube → read+write the user's playlists
// (for sync). youtube.readonly would block writing the destination playlist.
const SCOPES = ["openid", "email", "profile", "https://www.googleapis.com/auth/youtube"].join(" ");

const TIMEOUT_MS = 8000;
const FORM = { "content-type": "application/x-www-form-urlencoded" };

/** The URL we redirect the user to. `state` is echoed back for CSRF checking. */
export function googleAuthUrl(clientId: string, redirectUri: string, state: string): string {
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPES,
    state,
    access_type: "offline", // get a refresh_token
    prompt: "consent", // force refresh_token even on re-auth
    include_granted_scopes: "true",
  });
  return `${AUTH_URL}?${q.toString()}`;
}

interface GoogleTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  id_token?: string;
  error?: string;
  error_description?: string;
}

// id_token is a JWT issued directly by Google over TLS at the token endpoint, so
// decoding the payload (without re-verifying the signature) is safe for reading
// the user's identity.
function decodeIdToken(idToken: string): GoogleProfile {
  const payload = idToken.split(".")[1];
  const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
  const c = JSON.parse(json) as { sub: string; email?: string; name?: string; picture?: string };
  return { sub: c.sub, email: c.email, name: c.name, picture: c.picture };
}

function toTokenSet(j: GoogleTokenResponse): TokenSet {
  return {
    access_token: j.access_token!,
    refresh_token: j.refresh_token,
    expires_at: j.expires_in ? Date.now() + j.expires_in * 1000 : undefined,
    scope: j.scope,
  };
}

/** Exchange the callback `code` for tokens + the signed-in user's profile. */
export async function googleExchange(
  creds: OAuthCreds,
  code: string,
  redirectUri: string,
): Promise<{ tokens: TokenSet; profile: GoogleProfile }> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: FORM,
    body: new URLSearchParams({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    }).toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const j = (await res.json()) as GoogleTokenResponse;
  if (!res.ok || !j.access_token || !j.id_token) {
    throw new Error(j.error_description || j.error || `google token ${res.status}`);
  }
  return { tokens: toTokenSet(j), profile: decodeIdToken(j.id_token) };
}

/** Exchange a stored refresh_token for a fresh access_token. */
export async function googleRefresh(creds: OAuthCreds, refreshToken: string): Promise<TokenSet> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: FORM,
    body: new URLSearchParams({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }).toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const j = (await res.json()) as GoogleTokenResponse;
  if (!res.ok || !j.access_token) throw new Error(j.error_description || j.error || `google refresh ${res.status}`);
  return toTokenSet(j);
}
