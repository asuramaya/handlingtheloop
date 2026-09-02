// WHICH SITE IS THIS REQUEST FOR?
//
// One Worker serves two faces: the APP (the SPA, its API, its WebSocket) and, optionally, a
// LANDING site on the bare domain. The split exists for a specific technical reason, not for
// tidiness: the app stamps `COOP: same-origin` + `COEP: credentialless` on every document so
// `crossOriginIsolated` is true — that is what unlocks SharedArrayBuffer and threaded wasm for
// stem separation. Those same headers break exactly what a marketing page is made of: YouTube
// embeds, third-party widgets, analytics snippets. Two hostnames let each have its headers.
//
// ★ INERT UNTIL CONFIGURED. Both knobs empty — the default, and what ships today — means every
// request routes to the app, which is precisely the single-origin behaviour that has always run.
// Nothing about a deploy changes until someone sets APP_HOST or SITE_HOST.
//
// The two are independent. SITE_HOST alone fixes the duplicate-hostname problem that exists RIGHT
// NOW, with no split at all: apex and www both routed, both serving the same page, each claiming
// itself as canonical in the share card.
//
// ★ THE API NEVER MOVES OFF THE APP'S ORIGIN, and it keeps answering on the marketing host too
// (see below). `/api/art` is same-origin ON PURPOSE — that is what keeps the canvas untainted for
// per-track palette theming — and the same goes for the R2 audio proxy and the WS origin
// allowlist. Splitting the API away from the SPA would trade all of that for nothing.
//
// The decision lives here, pure, so it can be tested exhaustively instead of reasoned about
// inside a fetch handler.

/** A hostname nobody should be canonicalised away from: local dev, an IP, and the workers.dev
 *  preview domain — bouncing a preview deploy to production would make previews useless. */
function isDevHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".workers.dev") ||
    /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) ||
    hostname.includes(":")
  );
}

export type HostRoute =
  /** Serve the app: the SPA shell, with the isolation headers. */
  | { kind: "app" }
  /** Serve the landing document instead of the SPA shell. No isolation headers. */
  | { kind: "landing" }
  /** A share link on the marketing host: serve the OG card here, send a human to `to`. */
  | { kind: "share"; to: string }
  /** An app deep link that arrived on the marketing host, or a request to a non-canonical
   *  hostname: permanent redirect. */
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

export function routeForHost(url: URL, appHost?: string, siteHost?: string): HostRoute {
  const app = norm(appHost);
  const site = norm(siteHost);
  const host = url.hostname.toLowerCase();
  const at = (h: string) => `https://${h}${url.pathname}${url.search}`;

  // Shared infrastructure answers on EVERY hostname, before any redirect can touch it. A
  // canonicalisation that 301'd the API would break every open tab, every live socket, and the
  // OAuth redirect URIs already registered against whichever host is being redirected away.
  if (isSharedPath(url.pathname)) return { kind: "app" };

  // The app's own hostname is never canonicalised anywhere.
  if (app && host === app) return { kind: "app" };

  // ★ ONE HOSTNAME FOR ONE PAGE. With apex and www both routed, both served the same document —
  // and the OG card builds og:url from the request's own origin, so a profile shared from www
  // claimed www as canonical while the same profile shared from the apex claimed the apex. Two
  // URLs for one thing, each undercutting the other. SITE_HOST names the one that counts;
  // everything else is a 301 to it, path and query intact.
  if (site && host !== site && !isDevHost(host)) return { kind: "redirect", to: at(site) };

  // No split configured: the site host serves the app, as it always has.
  if (!app) return { kind: "app" };

  // The marketing host, split on.
  if (isSharePath(url.pathname)) return { kind: "share", to: at(app) };
  if (isLandingPath(url.pathname)) return { kind: "landing" };
  return { kind: "redirect", to: at(app) };
}

function norm(h: string | undefined): string {
  return (h ?? "").trim().toLowerCase();
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
