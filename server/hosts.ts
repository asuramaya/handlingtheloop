// WHICH SITE IS THIS REQUEST FOR?
//
// One Worker serves two faces: the APP (the SPA, its API, its WebSocket) and, optionally, a
// LANDING site on the bare domain. The split exists for a specific technical reason, not for
// tidiness: the app stamps `COOP: same-origin` + `COEP: credentialless` on every document so
// `crossOriginIsolated` is true — that is what unlocks SharedArrayBuffer and threaded wasm for
// stem separation. Those same headers break exactly what a marketing page is made of: YouTube
// embeds, third-party widgets, analytics snippets. Two hostnames let each have its headers.
//
// ★ INERT UNTIL CONFIGURED. `appHost` empty — the default, and what ships today — means every
// request routes to the app, which is precisely the single-origin behaviour that has always run.
// Nothing about a deploy changes until someone sets APP_HOST.
//
// ★ THE API NEVER MOVES OFF THE APP'S ORIGIN, and it keeps answering on the marketing host too
// (see below). `/api/art` is same-origin ON PURPOSE — that is what keeps the canvas untainted for
// per-track palette theming — and the same goes for the R2 audio proxy and the WS origin
// allowlist. Splitting the API away from the SPA would trade all of that for nothing.
//
// The decision lives here, pure, so it can be tested exhaustively instead of reasoned about
// inside a fetch handler.

export type HostRoute =
  /** Serve the app: the SPA shell, with the isolation headers. */
  | { kind: "app" }
  /** Serve the landing document instead of the SPA shell. No isolation headers. */
  | { kind: "landing" }
  /** A share link on the marketing host: serve the OG card here, send a human to `to`. */
  | { kind: "share"; to: string }
  /** An app deep link that arrived on the marketing host: permanent redirect. */
  | { kind: "redirect"; to: string };

/** Paths whose whole job is to be SHARED. They must keep their short, memorable form on the bare
 *  domain — the link is the product — so they are served there, card and all, and hand the human
 *  across afterwards. A crawler reads the meta tags and never follows the handoff. */
export function isSharePath(pathname: string): boolean {
  const path = safeDecode(pathname);
  return /^\/@[A-Za-z0-9_]{1,20}$/.test(path) || /^\/set\/[A-Za-z0-9-]{6,40}$/.test(path);
}

/** Paths the marketing site owns outright — everything else on that host belongs to the app. */
function isLandingPath(pathname: string): boolean {
  return pathname === "/" || pathname === "/index.html" || pathname === "/landing.html";
}

/** Never redirect these anywhere: they are the API, the socket, the internal bridge, and the
 *  files a site has to serve from its own root to be a site at all. */
function isSharedPath(pathname: string): boolean {
  return (
    pathname.startsWith("/api/") ||
    pathname === "/api/room" ||
    pathname.startsWith("/internal/") ||
    pathname === "/robots.txt" ||
    pathname === "/sitemap.xml" ||
    pathname === "/favicon.ico" ||
    pathname.startsWith("/.well-known/")
  );
}

export function routeForHost(url: URL, appHost: string | undefined): HostRoute {
  const host = (appHost ?? "").trim().toLowerCase();
  // Not configured, or this IS the app's hostname → the app, exactly as before.
  if (!host || url.hostname.toLowerCase() === host) return { kind: "app" };
  // The marketing host. Shared infrastructure answers here too — a cutover that broke the API on
  // the old hostname would break every open tab and every registered OAuth redirect at once.
  if (isSharedPath(url.pathname)) return { kind: "app" };
  const to = `https://${host}${url.pathname}${url.search}`;
  if (isSharePath(url.pathname)) return { kind: "share", to };
  if (isLandingPath(url.pathname)) return { kind: "landing" };
  return { kind: "redirect", to };
}

/** A share page for the marketing host: the OG block a crawler came for, and a meta-refresh for
 *  the human behind it. `<meta http-equiv="refresh">` and not a script because the CSP has no
 *  'unsafe-inline' — an inline redirect would simply not run — and not a 302 because a redirect
 *  would carry the crawler away from the URL that was actually shared, which is where the card
 *  has to be. The <a> is the fallback for anything that honours neither. */
export function shareBridgeHtml(meta: string, to: string): string {
  const href = escapeAttr(to);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="0;url=${href}">
<link rel="canonical" href="${href}">
${meta}
</head>
<body style="margin:0;display:grid;place-items:center;min-height:100vh;background:#0b0f14;color:#e8eef5;font:14px/1.5 system-ui,sans-serif">
<a href="${href}" style="color:#00e5ff">Continue to Handling The Loop</a>
</body>
</html>`;
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Some hosts hand us `/%40handle` for `/@handle`. A malformed escape must not throw here — an
 *  un-decodable path is simply not a share path. */
function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
