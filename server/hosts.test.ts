import { describe, expect, it } from "vitest";
import { isSharePath, routeForHost, shareBridgeHtml } from "./hosts";

const at = (u: string) => new URL(u);
const APP = "app.handlingtheloop.com";

describe("routeForHost — unconfigured is the old world", () => {
  it("routes everything to the app when APP_HOST is unset", () => {
    for (const u of ["https://handlingtheloop.com/", "https://www.handlingtheloop.com/@nina", "https://handlingtheloop.com/settings"]) {
      expect(routeForHost(at(u), undefined)).toEqual({ kind: "app" });
      expect(routeForHost(at(u), "")).toEqual({ kind: "app" });
      expect(routeForHost(at(u), "   ")).toEqual({ kind: "app" });
    }
  });
});

describe("routeForHost — the app's own hostname", () => {
  it("serves the app for every path, share links included", () => {
    for (const p of ["/", "/@nina", "/set/abc123", "/settings", "/api/me"]) {
      expect(routeForHost(at(`https://${APP}${p}`), APP)).toEqual({ kind: "app" });
    }
  });
  it("matches the hostname case-insensitively", () => {
    expect(routeForHost(at(`https://APP.Handlingtheloop.com/`), APP)).toEqual({ kind: "app" });
    expect(routeForHost(at("https://handlingtheloop.com/"), "APP.handlingtheloop.com")).toEqual({ kind: "landing" });
  });
});

describe("routeForHost — the marketing hostname", () => {
  it("serves the landing at the root", () => {
    expect(routeForHost(at("https://handlingtheloop.com/"), APP)).toEqual({ kind: "landing" });
    expect(routeForHost(at("https://www.handlingtheloop.com/index.html"), APP)).toEqual({ kind: "landing" });
    // the asset's own path, so hitting it directly serves it rather than bouncing to an app 404
    expect(routeForHost(at("https://handlingtheloop.com/landing.html"), APP)).toEqual({ kind: "landing" });
  });

  // ★ The cutover must not break open tabs, live sockets, or the OAuth redirect URIs already
  // registered with three providers — all of which point at the old hostname.
  it("keeps answering the API, the socket and the internal bridge", () => {
    for (const p of ["/api/me", "/api/room", "/api/auth/google/callback", "/internal/notify"]) {
      expect(routeForHost(at(`https://handlingtheloop.com${p}`), APP)).toEqual({ kind: "app" });
    }
  });

  it("keeps the files a site serves from its own root", () => {
    for (const p of ["/robots.txt", "/sitemap.xml", "/favicon.ico", "/.well-known/acme-challenge/x"]) {
      expect(routeForHost(at(`https://handlingtheloop.com${p}`), APP)).toEqual({ kind: "app" });
    }
  });

  it("serves a share link HERE and hands the human across", () => {
    expect(routeForHost(at("https://handlingtheloop.com/@nina"), APP)).toEqual({
      kind: "share",
      to: `https://${APP}/@nina`,
    });
    expect(routeForHost(at("https://handlingtheloop.com/set/abc123def"), APP)).toEqual({
      kind: "share",
      to: `https://${APP}/set/abc123def`,
    });
  });

  it("redirects every other app deep link, query string intact", () => {
    expect(routeForHost(at("https://handlingtheloop.com/settings?tab=midi"), APP)).toEqual({
      kind: "redirect",
      to: `https://${APP}/settings?tab=midi`,
    });
  });
});

describe("isSharePath", () => {
  it("accepts the two share shapes, including a percent-encoded @", () => {
    expect(isSharePath("/@nina")).toBe(true);
    expect(isSharePath("/%40nina")).toBe(true);
    expect(isSharePath("/set/abcdef")).toBe(true);
  });
  it("rejects near-misses", () => {
    expect(isSharePath("/@")).toBe(false);
    expect(isSharePath("/@nina/extra")).toBe(false);
    expect(isSharePath("/@this-handle-is-far-too-long-to-be-real")).toBe(false);
    expect(isSharePath("/set/short")).toBe(false);
    expect(isSharePath("/settings")).toBe(false);
  });
  it("does not throw on a malformed escape", () => {
    expect(isSharePath("/%E0%A4%A")).toBe(false);
  });
});

describe("shareBridgeHtml", () => {
  it("carries the card, the refresh, the canonical and a clickable fallback", () => {
    const html = shareBridgeHtml('<meta property="og:title" content="x">', `https://${APP}/@nina`);
    expect(html).toContain('<meta property="og:title" content="x">');
    expect(html).toContain(`<meta http-equiv="refresh" content="0;url=https://${APP}/@nina">`);
    expect(html).toContain(`<link rel="canonical" href="https://${APP}/@nina">`);
    expect(html).toContain(`<a href="https://${APP}/@nina"`);
  });
  it("escapes the destination into its attributes", () => {
    const html = shareBridgeHtml("", `https://${APP}/@nina?a=1&b="x"`);
    expect(html).toContain("&amp;b=&quot;x&quot;");
    expect(html).not.toContain('b="x"');
  });
});
