// Google "TV and Limited-Input Device" OAuth 2.0 device flow — pure-JS, runs in
// both the Vite dev middleware (Node) and the Cloudflare Worker. No binaries, no
// node: imports, only global fetch.
//
// WHY THIS EXISTS
//   YouTube blocks the player API from datacenter IPs (the Worker) with a "confirm
//   you're not a bot" wall. A real signed-in session passes it. Instead of asking
//   users to copy a cookie, this lets them sign in to their OWN YouTube account by
//   typing a short code at google.com/device — one tap, auto-refreshing, revocable
//   from their Google account page.
//
// SECRETS
//   The credentials below are the YouTube-on-TV app's WELL-KNOWN PUBLIC values —
//   the same ones shipped in youtubei.js and yt-dlp, shared by every client on
//   earth. They are NOT a deployment secret: there is nothing here to protect, so
//   the repo stays public. The resulting tokens live in the USER's browser and are
//   forwarded per-request to our same-origin Worker (never stored server-side) —
//   see the in-app privacy notice.
//
//   If you ever register your OWN Google OAuth app, override these via Worker
//   secrets (`wrangler secret put GOOGLE_OAUTH_CLIENT_ID` / `_CLIENT_SECRET`,
//   and a gitignored `.dev.vars` for local dev) — no code change needed.

const DEVICE_CODE_URL = "https://oauth2.googleapis.com/device/code";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

// Public, well-known YouTube-on-TV credentials (shipped in youtubei.js / yt-dlp).
const DEFAULT_CLIENT_ID = "861556708454-d6dlm3lh05idd8npek18k6be8ba3oc68.apps.googleusercontent.com";
const DEFAULT_CLIENT_SECRET = "SboVhoG9s0rNafixCSGGKXAT";
// Scopes the TV client is allowed to request: account-bound YouTube access
// (browse/library/playlists), which also makes the player API trust the request.
const SCOPE = [
  "http://gdata.youtube.com",
  "https://www.googleapis.com/auth/youtube",
  "https://www.googleapis.com/auth/youtube-paid-content",
].join(" ");

const TIMEOUT_MS = 8000;
const sig = (): RequestInit => ({ signal: AbortSignal.timeout(TIMEOUT_MS) });
const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
const FORM_HEADERS = { "content-type": "application/x-www-form-urlencoded" };

export interface OAuthCreds {
  clientId: string;
  clientSecret: string;
}

/** Resolve credentials from Worker secrets if present, else the public TV creds. */
export function oauthCreds(env?: { GOOGLE_OAUTH_CLIENT_ID?: string; GOOGLE_OAUTH_CLIENT_SECRET?: string }): OAuthCreds {
  // .trim() — pasted secrets often carry a stray leading/trailing space or
  // newline, which Google rejects as `invalid_client`.
  return {
    clientId: (env?.GOOGLE_OAUTH_CLIENT_ID || DEFAULT_CLIENT_ID).trim(),
    clientSecret: (env?.GOOGLE_OAUTH_CLIENT_SECRET || DEFAULT_CLIENT_SECRET).trim(),
  };
}

export interface DeviceStart {
  device_code: string; // secret handle the browser holds and polls with
  user_code: string; // short code the user types
  verification_url: string; // where they type it (google.com/device)
  expires_in: number; // seconds until device_code dies
  interval: number; // min seconds between polls
}

/** Step 1: ask Google for a device + user code. */
export async function startDeviceAuth(creds: OAuthCreds): Promise<DeviceStart> {
  const res = await fetch(DEVICE_CODE_URL, {
    method: "POST",
    headers: FORM_HEADERS,
    body: form({ client_id: creds.clientId, scope: SCOPE }),
    ...sig(),
  });
  const j = (await res.json()) as Record<string, string | number>;
  if (!res.ok) throw new Error(String(j.error_description || j.error || `device ${res.status}`));
  return {
    device_code: String(j.device_code),
    user_code: String(j.user_code),
    verification_url: String(j.verification_url || j.verification_uri || "https://www.google.com/device"),
    expires_in: Number(j.expires_in) || 1800,
    interval: Number(j.interval) || 5,
  };
}

export interface TokenSet {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
  scope?: string;
}

// Polling outcomes. Only "ok" carries tokens; the rest tell the browser how to
// proceed (keep waiting / back off / give up).
export type PollResult =
  | { status: "pending" }
  | { status: "slow_down" }
  | { status: "denied" }
  | { status: "expired" }
  | { status: "ok"; tokens: TokenSet };

/** Step 2: poll until the user authorizes (or the code expires / is denied). */
export async function pollDeviceAuth(creds: OAuthCreds, deviceCode: string): Promise<PollResult> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: FORM_HEADERS,
    body: form({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      device_code: deviceCode,
      grant_type: DEVICE_GRANT,
    }),
    ...sig(),
  });
  const j = (await res.json()) as Record<string, string | number>;
  if (res.ok && j.access_token) return { status: "ok", tokens: j as unknown as TokenSet };
  switch (j.error) {
    case "authorization_pending":
      return { status: "pending" };
    case "slow_down":
      return { status: "slow_down" };
    case "access_denied":
      return { status: "denied" };
    case "expired_token":
      return { status: "expired" };
    default:
      throw new Error(String(j.error_description || j.error || `token ${res.status}`));
  }
}

/** Exchange a stored refresh_token for a fresh access_token (no new refresh_token). */
export async function refreshAccessToken(creds: OAuthCreds, refreshToken: string): Promise<TokenSet> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: FORM_HEADERS,
    body: form({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
    ...sig(),
  });
  const j = (await res.json()) as Record<string, string | number>;
  if (!res.ok || !j.access_token) throw new Error(String(j.error_description || j.error || `refresh ${res.status}`));
  return j as unknown as TokenSet;
}
