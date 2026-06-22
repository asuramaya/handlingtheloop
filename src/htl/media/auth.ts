// User-supplied YouTube credentials, sent (per request) to our own Worker, which
// forwards them to YouTube so the user passes the "confirm you're not a bot"
// challenge with their OWN session.
//
// Google sign-in (OAuth) — scoped + revocable + auto-refreshing — is the ONLY
// account credential now. It powers playlist/library browsing. (The legacy
// "paste your youtube.com cookie" streaming path was REMOVED for security: the
// residential relay covers cold loads past the bot wall, so a full Google session
// never has to transit the Worker. See docs/security-handoff.md Tier 3.)
import { Store } from "../persistence";

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number; // epoch ms when the access token stops working
}

export interface YtAuth {
  visitorData?: string; // browser-minted visitorData
  poToken?: string; // BotGuard PO token bound to that visitorData
  oauth?: OAuthTokens; // device-code sign-in tokens
}

// The persistent store holds ONLY the non-sensitive, browser-minted hints
// (visitorData / poToken). The OAuth tokens are session-only — see the holder below.
const store = new Store<YtAuth>("ytauth", {}, 2);

// ---------------------------------------------------------------------------
// OAuth tokens — session-only (NOT localStorage)
// ---------------------------------------------------------------------------
// The device-code tokens are account-adjacent: an access token (browse the user's
// library) + a long-lived refresh token. Held in memory + sessionStorage only, so
// they're gone when the tab closes and never sit on disk where another-origin/
// extension read or a residual XSS could lift them. (The main-origin CSP blocks
// injected script; this is depth.) Trade-off: sign-in no longer survives fully
// closing the browser — the one-tap device-code flow re-establishes it.
const OAUTH_KEY = "htl.ytoauth";
let oauthMem: OAuthTokens | null = null;
let oauthLoaded = false;

function readOAuth(): OAuthTokens | null {
  if (!oauthLoaded) {
    try {
      const raw = sessionStorage.getItem(OAUTH_KEY);
      oauthMem = raw ? (JSON.parse(raw) as OAuthTokens) : null;
    } catch {
      oauthMem = null;
    }
    oauthLoaded = true;
  }
  return oauthMem;
}

function writeOAuth(tok: OAuthTokens | null): void {
  oauthMem = tok;
  oauthLoaded = true;
  try {
    if (tok) sessionStorage.setItem(OAUTH_KEY, JSON.stringify(tok));
    else sessionStorage.removeItem(OAUTH_KEY);
  } catch {
    /* memory-only if sessionStorage is blocked */
  }
}

// One-time migration: pull any OAuth tokens that earlier builds persisted on disk
// (legacy v1, or the v2 ytauth store) into the session-only holder, and scrub them
// from localStorage so they never linger there.
try {
  const legacy = localStorage.getItem("htl.ytauth.v1");
  if (legacy) {
    const p = JSON.parse(legacy) as YtAuth;
    if (p?.visitorData || p?.poToken) store.set({ visitorData: p.visitorData, poToken: p.poToken });
    if (p?.oauth) writeOAuth(p.oauth);
    localStorage.removeItem("htl.ytauth.v1"); // drops the old persisted tokens (and any legacy cookie)
  }
  const cur = store.get();
  if (cur.oauth) {
    writeOAuth(cur.oauth); // promote to the session-only holder…
    const { oauth: _drop, ...rest } = cur;
    store.set(rest); // …and scrub the token off disk
  }
} catch {
  /* storage unavailable — nothing to migrate */
}

export function getYtAuth(): YtAuth {
  return { ...store.get(), oauth: readOAuth() ?? undefined };
}

export function setYtAuth(a: YtAuth): void {
  const { oauth, ...rest } = a;
  store.set(rest);
  writeOAuth(oauth ?? null);
}

export function clearYtAuth(): void {
  store.clear();
  writeOAuth(null);
}

/** Any credential connected at all (OAuth or a browser-minted hint). */
export function hasYtAuth(): boolean {
  const a = store.get();
  return !!(readOAuth()?.accessToken || a.visitorData || a.poToken);
}

/** Signed in via Google. */
export function isSignedIn(): boolean {
  return !!readOAuth()?.accessToken;
}

// ---------------------------------------------------------------------------
// Google device-code sign-in
// ---------------------------------------------------------------------------

export interface DeviceStart {
  device_code: string;
  user_code: string;
  verification_url: string;
  expires_in: number;
  interval: number;
}

export type SignInPoll =
  | { status: "pending" }
  | { status: "slow_down" }
  | { status: "denied" }
  | { status: "expired" }
  | { status: "ok" };

interface RawTokenSet {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((j as { error?: string }).error || `HTTP ${res.status}`);
  return j as T;
}

const tokensFrom = (t: RawTokenSet, prevRefresh?: string): OAuthTokens => ({
  accessToken: t.access_token,
  // A refresh response omits refresh_token — keep the one we already have.
  refreshToken: t.refresh_token ?? prevRefresh,
  expiresAt: Date.now() + (t.expires_in || 3600) * 1000,
});

/** Begin sign-in: returns the code + URL to show the user. */
export function startGoogleSignIn(): Promise<DeviceStart> {
  return postJson<DeviceStart>("/api/auth/device", {});
}

/** Poll once; on "ok" the tokens are persisted and headers go live immediately. */
export async function pollGoogleSignIn(deviceCode: string): Promise<SignInPoll> {
  const r = await postJson<{ status: string; tokens?: RawTokenSet }>("/api/auth/poll", { device_code: deviceCode });
  if (r.status === "ok" && r.tokens) {
    writeOAuth(tokensFrom(r.tokens));
    return { status: "ok" };
  }
  return { status: r.status as SignInPoll["status"] };
}

/** Sign out of Google but leave the browser-minted visitor data intact. */
export function signOutGoogle(): void {
  writeOAuth(null);
}

// Single-flight refresh: many requests can fire at once after the token expires;
// only one network refresh should run, the rest await it.
let refreshing: Promise<OAuthTokens | null> | null = null;

async function refreshIfNeeded(a: YtAuth): Promise<OAuthTokens | null> {
  const tok = a.oauth;
  if (!tok) return null;
  // Refresh ~1 min before expiry (or if already expired) when we have a refresh token.
  if (tok.expiresAt - Date.now() > 60_000 || !tok.refreshToken) return tok;
  if (!refreshing) {
    refreshing = (async () => {
      try {
        const t = await postJson<RawTokenSet>("/api/auth/refresh", { refresh_token: tok.refreshToken });
        const next = tokensFrom(t, tok.refreshToken);
        writeOAuth(next);
        return next;
      } catch {
        return tok; // refresh failed — try the (stale) token, let the request surface the error
      } finally {
        refreshing = null;
      }
    })();
  }
  return refreshing;
}

// Request headers carrying the credentials to the Worker (omitted when unset).
// Async because it may refresh an expired OAuth access token first. Used for
// BROWSE (playlists / library / meta) — sends the OAuth token (private playlists
// need the account) plus any browser-minted bot-wall hints.
export async function ytAuthHeaders(): Promise<Record<string, string>> {
  const a = getYtAuth();
  const h: Record<string, string> = {};
  const tok = await refreshIfNeeded(a);
  if (tok?.accessToken) h["x-htl-yt-token"] = tok.accessToken;
  if (a.visitorData) h["x-htl-yt-visitor"] = a.visitorData.trim();
  if (a.poToken) h["x-htl-yt-potoken"] = a.poToken.trim();
  return h;
}

// Headers for STREAMING audio. Streaming is ANONYMOUS-ONLY — the decode path needs
// a YouTube DIRECT stream (ANDROID_VR), which account credentials can't unlock here,
// so no token is ever sent. A browser-minted visitorData / PO token (when present)
// just hardens the anonymous request against datacenter bot-blocks.
export async function ytStreamHeaders(): Promise<Record<string, string>> {
  const a = store.get();
  const h: Record<string, string> = {};
  if (a.visitorData) h["x-htl-yt-visitor"] = a.visitorData.trim();
  if (a.poToken) h["x-htl-yt-potoken"] = a.poToken.trim();
  return h;
}
