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

// Exactly the scopes the code actually exercises, no more:
//   collection.read→ /userCollections/{id}/relationships/playlists (how we list playlists)
//   playlists.read → read a playlist's tracks (getTidalPlaylistTracks)
//   playlists.write→ create the synced playlist + add tracks (createTidalPlaylist/addTidalTracks)
//   search.read    → match tracks during sync (searchTidalTracks/tidalTrackIdByIsrc) — sync
//                    silently fails at the matching step without it
// ⚠ We do NOT request `user.read`: the registered handlingtheloop app is NOT provisioned for it
// (its allowed scopes are collection.read / entitlements.read / playlists.read / playlists.write /
// recommendations.read / search.read), and TIDAL rejects the WHOLE authorize request — hosted
// login shows "Something went wrong" / error 1002 — the moment we ask for a scope outside that set.
// The provider_user_id (every playlist call is scoped by it) comes from the token-exchange response
// (`user_id`, see toTokenSet); the /users/me backfill is only a best-effort fallback and is allowed
// to fail without user.read. We also deliberately DON'T request collection.write (we never touch
// favorites), playback (TIDAL is catalog/metadata-only here — DRM-locked, never streamed),
// entitlements.read, search.write, or recommendations.read (track-radio uses the app token). TIDAL
// also requires the redirect_uri to EXACTLY match a registered one (scheme+host+path, no trailing
// slash, www vs apex matters). Overridable via the TIDAL_SCOPES env (e.g. to bisect a scope).
const SCOPES = ["collection.read", "playlists.read", "playlists.write", "search.read"].join(" ");

/** The scope string to request — the TIDAL_SCOPES env override, else the default set. */
export function tidalScopes(env?: { TIDAL_SCOPES?: string }): string {
  return env?.TIDAL_SCOPES?.trim() || SCOPES;
}

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
export function tidalAuthUrl(
  clientId: string,
  redirectUri: string,
  state: string,
  codeChallenge: string,
  scope: string = SCOPES,
): string {
  // Build the query by hand. URLSearchParams serializes spaces as "+", but TIDAL's
  // /authorize only accepts RFC-3986 percent-encoding (%20) in `scope` — a "+"-joined
  // value is parsed as ONE bogus scope and the request fails with error 11102 on the
  // hosted login page. encodeURIComponent emits %20 for spaces, so the scopes survive.
  const params: [string, string][] = [
    ["client_id", clientId],
    ["response_type", "code"],
    ["redirect_uri", redirectUri],
    ["scope", scope],
    ["state", state],
    ["code_challenge_method", "S256"],
    ["code_challenge", codeChallenge],
  ];
  const q = params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
  return `${AUTH_URL}?${q}`;
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

// --- Client-credentials (app token) -----------------------------------------
// TIDAL's CATALOG endpoints (search, tracks, track-radio) are 2-legged: a
// client-credentials token minted from the app's id/secret reads them with NO user
// login. This is what lets the auto-mixer use TIDAL relatedness without every user
// linking a TIDAL account — and lets the dev probe work with just the two secrets.
let clientTokenCache: { token: string; exp: number } | null = null;

export async function tidalClientToken(creds: TidalCreds | null): Promise<string | null> {
  if (!creds) return null;
  if (clientTokenCache && clientTokenCache.exp - 30_000 > Date.now()) return clientTokenCache.token;
  try {
    const basic = btoa(`${creds.clientId}:${creds.clientSecret}`);
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { ...FORM, authorization: `Basic ${basic}` },
      body: new URLSearchParams({ grant_type: "client_credentials" }).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const j = (await res.json()) as TidalTokenResponse;
    if (!res.ok || !j.access_token) return null;
    clientTokenCache = { token: j.access_token, exp: Date.now() + (j.expires_in ?? 3600) * 1000 };
    return j.access_token;
  } catch {
    return null;
  }
}

/** Diagnostic: attempt a client-credentials token and report the raw outcome, so we
 *  can tell "no creds" from "Tidal rejected them" (and read the error reason). */
export async function tidalClientTokenDebug(creds: TidalCreds | null): Promise<{
  hasCreds: boolean;
  clientIdLen?: number;
  ok: boolean;
  status?: number;
  body?: string;
}> {
  if (!creds) return { hasCreds: false, ok: false };
  try {
    const basic = btoa(`${creds.clientId}:${creds.clientSecret}`);
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { ...FORM, authorization: `Basic ${basic}` },
      body: new URLSearchParams({ grant_type: "client_credentials" }).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = await res.text();
    return { hasCreds: true, clientIdLen: creds.clientId.length, ok: res.ok, status: res.status, body: body.slice(0, 300) };
  } catch (e) {
    return { hasCreds: true, clientIdLen: creds.clientId.length, ok: false, body: (e as Error).message };
  }
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
