// User-supplied YouTube credentials, sent (per request) to our own Worker, which
// forwards them to YouTube so the user passes the "confirm you're not a bot"
// challenge with their OWN session. Two very different risk profiles:
//
//   1. Google sign-in (OAuth) — scoped + revocable + auto-refreshing. Low risk,
//      so it lives in localStorage. Powers playlist/library browsing (it can't
//      fetch audio — see the streaming cookie).
//   2. Streaming cookie — account-grade (a full Google session), the only thing
//      that loads new tracks past the bot wall. Treated as SENSITIVE: kept in
//      memory + sessionStorage only (NEVER localStorage), time-boxed with a TTL,
//      and trimmed to the minimum cookies the request needs. Gone when the tab
//      closes. See the ephemeral cookie section below.
import { Store } from "../persistence";

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number; // epoch ms when the access token stops working
}

// NOTE: the streaming cookie is deliberately NOT in this (persistent) store.
export interface YtAuth {
  visitorData?: string; // browser-minted visitorData
  poToken?: string; // BotGuard PO token bound to that visitorData
  oauth?: OAuthTokens; // device-code sign-in tokens
}

// The persistent store now holds ONLY the non-sensitive, browser-minted hints
// (visitorData / poToken). The OAuth tokens were moved off localStorage — see the
// session-only holder below.
const store = new Store<YtAuth>("ytauth", {}, 2);

// ---------------------------------------------------------------------------
// OAuth tokens — session-only (NOT localStorage)
// ---------------------------------------------------------------------------
// The device-code tokens are account-adjacent: an access token (browse the user's
// library) + a long-lived refresh token. Treat them like the streaming cookie —
// held in memory + sessionStorage only, so they're gone when the tab closes and
// never sit on disk where another-origin/extension read or a residual XSS could
// lift them. (The new main-origin CSP blocks injected script; this is depth.)
// Trade-off: sign-in no longer survives fully closing the browser — the one-tap
// device-code flow re-establishes it.
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
    const p = JSON.parse(legacy) as YtAuth & { cookie?: string };
    if (p?.visitorData || p?.poToken) store.set({ visitorData: p.visitorData, poToken: p.poToken });
    if (p?.oauth) writeOAuth(p.oauth);
    localStorage.removeItem("htl.ytauth.v1"); // drops the old persisted cookie + tokens
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

/** Any credential connected at all (OAuth or cookie). */
export function hasYtAuth(): boolean {
  const a = store.get();
  return !!(readOAuth()?.accessToken || hasCookie() || a.visitorData || a.poToken);
}

/** Specifically signed in via Google (vs. a pasted cookie). */
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

/** Sign out of Google but leave any pasted cookie/visitor data intact. */
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

// ---------------------------------------------------------------------------
// Cookie parsing (streaming auth) — minimal by design
// ---------------------------------------------------------------------------
// Accept a Netscape cookies.txt export (from "Get cookies.txt LOCALLY"), a JSON
// cookie export, or a raw Cookie header, and distil it to the `name=value; …`
// header YouTube needs — keeping ONLY the cookies the request uses and dropping
// everything else (ad/analytics/unrelated google.com cookies) to shrink what's
// ever held. SAPISIDHASH needs a SAPISID-family cookie, so we flag its presence.
const AUTH_KEYS = ["SAPISID", "__Secure-3PAPISID", "__Secure-1PAPISID"];

// The only cookies we keep. Two groups: the authenticated-session cluster (used
// when signed in) and the anonymous visitor/consent cookies (used for a
// signed-OUT export — no account, ~zero blast radius). Anything not here is
// discarded before storage.
const KEEP_COOKIES = new Set<string>([
  // authenticated session (SAPISIDHASH)
  "SID", "HSID", "SSID", "APISID", "SAPISID", "LOGIN_INFO", "SIDCC",
  "__Secure-1PSID", "__Secure-3PSID", "__Secure-1PAPISID", "__Secure-3PAPISID",
  "__Secure-1PSIDCC", "__Secure-3PSIDCC", "__Secure-1PSIDTS", "__Secure-3PSIDTS",
  // anonymous visitor / consent / preferences
  "VISITOR_INFO1_LIVE", "VISITOR_PRIVACY_METADATA", "__Secure-YEC", "YSC",
  "PREF", "CONSENT", "SOCS", "__Secure-ROLLOUT_TOKEN",
]);

export interface ParsedCookies {
  header: string; // "name=value; …" of the kept youtube.com cookies
  count: number;
  hasAuth: boolean; // a SAPISID-family cookie is present (i.e. a signed-in export)
}

export function parseCookieInput(raw: string): ParsedCookies {
  const text = raw.trim();
  const jar = new Map<string, string>();
  const add = (name: string, value: string) => {
    const n = name.trim();
    const v = value.trim();
    // Keep only the cookies we actually use — drop everything else immediately.
    if (n && v && KEEP_COOKIES.has(n)) jar.set(n, v);
  };

  // 1. JSON export (Cookie-Editor / EditThisCookie): [{ name, value, domain }, …]
  if (text.startsWith("[") || text.startsWith("{")) {
    try {
      const data = JSON.parse(text) as unknown;
      const arr = Array.isArray(data) ? data : ((data as { cookies?: unknown[] }).cookies ?? []);
      for (const c of arr as { name?: string; value?: string; domain?: string }[]) {
        const domain = String(c.domain ?? "");
        if (domain && !/youtube\.com|google\.com/.test(domain)) continue;
        add(String(c.name ?? ""), String(c.value ?? ""));
      }
    } catch {
      /* not JSON — fall through */
    }
  }

  // 2. Netscape cookies.txt: domain \t flag \t path \t secure \t expiry \t name \t value
  // CRITICAL: HttpOnly cookies (SAPISID etc. — the ones we actually need) are
  // written with a "#HttpOnly_" domain prefix; a naive "skip #" comment filter
  // would drop exactly those. Un-skip them.
  if (jar.size === 0 && text.includes("\t")) {
    for (const rawLine of text.split(/\r?\n/)) {
      let line = rawLine;
      if (line.startsWith("#HttpOnly_")) line = line.slice("#HttpOnly_".length);
      else if (!line.trim() || line.startsWith("#")) continue;
      const parts = line.split("\t");
      if (parts.length < 7) continue;
      if (!parts[0].includes("youtube.com")) continue;
      add(parts[5], parts.slice(6).join("\t"));
    }
  }

  // 3. Raw Cookie header: name=value; name2=value2
  if (jar.size === 0) {
    for (const pair of text.split(/;\s*/)) {
      const eq = pair.indexOf("=");
      if (eq > 0) add(pair.slice(0, eq), pair.slice(eq + 1));
    }
  }

  return {
    header: [...jar].map(([n, v]) => `${n}=${v}`).join("; "),
    count: jar.size,
    hasAuth: AUTH_KEYS.some((k) => jar.has(k)),
  };
}

// ---------------------------------------------------------------------------
// Ephemeral streaming cookie store
// ---------------------------------------------------------------------------
// Account-grade, so minimise exposure: held in memory + sessionStorage only
// (never localStorage → gone when the tab closes), and time-boxed with a TTL so
// it auto-purges even within a long session.
const COOKIE_KEY = "htl.ytcookie";
const COOKIE_TTL_MS = 8 * 60 * 60 * 1000; // 8h

interface CookieRecord {
  header: string;
  expiresAt: number;
}
let cookieMem: CookieRecord | null = null;

function readCookie(): CookieRecord | null {
  if (!cookieMem) {
    try {
      const raw = sessionStorage.getItem(COOKIE_KEY);
      if (raw) cookieMem = JSON.parse(raw) as CookieRecord;
    } catch {
      /* sessionStorage unavailable */
    }
  }
  if (cookieMem && cookieMem.expiresAt <= Date.now()) clearCookie(); // auto-expire
  return cookieMem;
}

/** Store the (already-minimised) cookie header for this session. Returns expiry ms. */
export function setCookie(header: string): number {
  cookieMem = { header, expiresAt: Date.now() + COOKIE_TTL_MS };
  try {
    sessionStorage.setItem(COOKIE_KEY, JSON.stringify(cookieMem));
  } catch {
    /* memory-only if sessionStorage is blocked */
  }
  return cookieMem.expiresAt;
}

export function clearCookie(): void {
  cookieMem = null;
  try {
    sessionStorage.removeItem(COOKIE_KEY);
  } catch {
    /* ignore */
  }
}

/** The current cookie header, or null if none/expired. */
export function getCookie(): string | null {
  return readCookie()?.header ?? null;
}

export function hasCookie(): boolean {
  return !!getCookie();
}

/**
 * Whether the connected cookie carries an actual ACCOUNT (a SAPISID-family
 * credential), vs an anonymous/signed-out cookie that can stream but has no
 * playlists. Used to decide if "MY YOUTUBE" (the user's own playlists) applies —
 * an anonymous cookie would just 401 on browse.
 */
export function hasAccountCookie(): boolean {
  const c = getCookie();
  return !!c && /(?:^|;\s*)(SAPISID|__Secure-3PAPISID|__Secure-1PAPISID)=/.test(c);
}

/** When the current cookie expires (epoch ms), or null if none. */
export function cookieExpiresAt(): number | null {
  return readCookie()?.expiresAt ?? null;
}

// Request headers carrying the credentials to the Worker (omitted when unset).
// Async because it may refresh an expired OAuth access token first. Used for
// BROWSE (playlists / library / meta), so it always sends everything available —
// private playlists need the account.
export async function ytAuthHeaders(): Promise<Record<string, string>> {
  const a = getYtAuth();
  const h: Record<string, string> = {};
  const tok = await refreshIfNeeded(a);
  if (tok?.accessToken) h["x-htl-yt-token"] = tok.accessToken;
  const cookie = getCookie();
  if (cookie) h["x-htl-yt-cookie"] = cookie;
  if (a.visitorData) h["x-htl-yt-visitor"] = a.visitorData.trim();
  if (a.poToken) h["x-htl-yt-potoken"] = a.poToken.trim();
  return h;
}

// Headers for STREAMING audio. Streaming is ANONYMOUS-ONLY — the decode path needs
// a YouTube DIRECT stream (ANDROID_VR), which account credentials can't unlock here,
// so no cookie/token is ever sent. A browser-minted visitorData / PO token (when
// present) just hardens the anonymous request against datacenter bot-blocks.
export async function ytStreamHeaders(): Promise<Record<string, string>> {
  const a = store.get();
  const h: Record<string, string> = {};
  if (a.visitorData) h["x-htl-yt-visitor"] = a.visitorData.trim();
  if (a.poToken) h["x-htl-yt-potoken"] = a.poToken.trim();
  return h;
}
