import { describe, expect, it } from "vitest";
import { ogBlock, defaultOgMeta } from "./index";

// THE HOMEPAGE CARD HAD NO PICTURE, and nothing said so.
//
// defaultOgMeta passed img: "" — so the bare domain unfurled as a text-only link everywhere it
// was pasted, while every /@handle and /set/ link got a rich card. It was not BROKEN (ogBlock's
// `large && img` guard correctly downgraded the twitter:card to `summary` rather than promising a
// large image it did not have), which is exactly why it survived: the degradation was graceful and
// silent, and no test asked the one question that matters — is there an image at all.

const url = new URL("https://handlingtheloop.com/");

describe("the default share card", () => {
  it("carries an image", () => {
    // The whole point of the fix. Stated as its own assertion so a future refactor that drops the
    // asset fails here rather than being noticed months later in a chat window.
    const meta = defaultOgMeta(url);
    expect(meta).toContain('<meta property="og:image" content="https://handlingtheloop.com/og.png">');
    expect(meta).toContain('<meta name="twitter:image" content="https://handlingtheloop.com/og.png">');
  });

  it("asks for the LARGE card, now that it has something to put in it", () => {
    expect(defaultOgMeta(url)).toContain('<meta name="twitter:card" content="summary_large_image">');
  });

  it("builds the image URL from the request's own origin, not a hardcoded host", () => {
    // Two routed hostnames exist (APP_HOST / SITE_HOST) and preview deployments have their own.
    // A hardcoded domain would serve the wrong origin's asset on all but one of them.
    const meta = defaultOgMeta(new URL("https://staging.example.dev/"));
    expect(meta).toContain('content="https://staging.example.dev/og.png"');
    expect(meta).not.toContain("handlingtheloop.com/og.png");
  });
});

describe("ogBlock degrades honestly", () => {
  it("downgrades to a SMALL card when there is no image — never promises one it lacks", () => {
    // The guard that kept the old imageless card from being actively broken. Worth keeping under
    // test precisely because it is what made the missing image invisible.
    const meta = ogBlock({ title: "T", desc: "D", img: "", url: "https://x.test/", large: true });
    expect(meta).toContain('<meta name="twitter:card" content="summary">');
    expect(meta).not.toContain("og:image");
  });

  it("escapes quotes and angle brackets out of every field", () => {
    // These strings are user data on the /@handle and /set/ paths — a display name or a set title.
    const meta = ogBlock({
      title: `x" onload="alert(1)`,
      desc: "<script>bad</script>",
      img: "https://x.test/a.png",
      url: "https://x.test/",
      large: true,
    });
    expect(meta).not.toContain('onload="alert(1)"');
    expect(meta).not.toContain("<script>");
    expect(meta).toContain("&quot;");
    expect(meta).toContain("&lt;script&gt;");
  });
});
