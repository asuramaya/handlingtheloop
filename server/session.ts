// httpOnly session cookie helpers. The cookie value is an opaque session id;
// the id→user mapping lives in D1 (see db.ts). Pure string/Request work — no
// storage here.

export const SESSION_COOKIE = "htl_session";
export const STATE_COOKIE = "htl_oauth_state";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function cookie(name: string, value: string, maxAgeSec: number): string {
  // Secure + SameSite=Lax: survives the OAuth redirect back to us, not sent
  // cross-site otherwise. Path=/ so every /api route sees it.
  return `${name}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAgeSec}`;
}

export function sessionCookie(id: string): string {
  return cookie(SESSION_COOKIE, id, Math.floor(SESSION_TTL_MS / 1000));
}
export function clearSessionCookie(): string {
  return cookie(SESSION_COOKIE, "", 0);
}

// Short-lived cookie holding the OAuth `state` we sent, to verify the callback
// (CSRF protection). 10 minutes is plenty for a sign-in.
export function stateCookie(state: string): string {
  return cookie(STATE_COOKIE, state, 600);
}
export function clearStateCookie(): string {
  return cookie(STATE_COOKIE, "", 0);
}

function readCookie(req: Request, name: string): string | null {
  const raw = req.headers.get("cookie") || "";
  const m = raw.match(new RegExp("(?:^|;\\s*)" + name + "=([^;]+)"));
  return m ? m[1] : null;
}

export const readSessionId = (req: Request): string | null => readCookie(req, SESSION_COOKIE);
export const readState = (req: Request): string | null => readCookie(req, STATE_COOKIE);

/** A URL-safe random token for session ids and OAuth state. */
export function randomToken(bytes = 32): string {
  const a = crypto.getRandomValues(new Uint8Array(bytes));
  let s = "";
  for (const b of a) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
