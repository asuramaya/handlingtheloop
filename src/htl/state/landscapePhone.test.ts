import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PHONE_QUERY, ONE_PANEL_QUERY, LANDSCAPE_PHONE_QUERY } from "./usePhone";

// THE JS AND THE CSS HAVE TO AGREE, and nothing else checks that they do.
//
// usePhone.ts says it in its own words: "Keep the breakpoint identical to the CSS one: a JS/CSS
// disagreement here means a sheet that opens with nowhere to render, or a panel that vanishes with
// no way back." That is a rule stated in prose and enforced by nobody — which is the exact shape
// of defect this codebase has been handing me all session. So it is enforced here.
//
// Thread f15158f3: a phone at 844x390 is WIDER than every width breakpoint in the repo and far
// shorter than the board they hand it, so the FX strip rendered 175px below the bottom edge with
// no scroll to reach it. The fix keys on a query that must exist, character for character, in both
// places.

const css = (p: string) => readFileSync(new URL(`../../styles/${p}`, import.meta.url), "utf8");

describe("the landscape-phone query", () => {
  it("is what mobile.css actually keys the split layout on, character for character", () => {
    // The load-bearing one. If the string here and the string there drift, the hook reports a
    // landscape phone while the stylesheet lays out a desktop, or the reverse — and both failures
    // are invisible until someone turns a phone sideways.
    expect(css("mobile.css")).toContain(`@media ${LANDSCAPE_PHONE_QUERY} {`);
  });

  it("tests HEIGHT and pointer, never width — width is what got this wrong", () => {
    // A phone in landscape clears every width breakpoint in the repo. Any width term creeping in
    // here would re-introduce the original bug with extra steps.
    expect(LANDSCAPE_PHONE_QUERY).toContain("max-height");
    expect(LANDSCAPE_PHONE_QUERY).toContain("pointer: coarse");
    expect(LANDSCAPE_PHONE_QUERY).not.toContain("width");
  });

  it("keeps `pointer: coarse`, which is what excludes a short DESKTOP window", () => {
    // A short-but-wide desktop window is just a short window: it has a cursor, it can drag a dock
    // edge, it is not a phone. Dropping the pointer term would hand the phone layout to anyone who
    // resizes a browser, which is a much louder bug than the one being fixed.
    expect(LANDSCAPE_PHONE_QUERY.replace(/\s/g, "")).toContain("pointer:coarse");
  });

  it("composes into ONE_PANEL_QUERY rather than being retyped beside it", () => {
    // It was inlined there before this. Two copies of one rule is how they start disagreeing.
    expect(ONE_PANEL_QUERY).toContain(LANDSCAPE_PHONE_QUERY);
    expect(ONE_PANEL_QUERY).toContain(PHONE_QUERY);
  });

  it("the split layout gives the controls their own scroll — the actual repair", () => {
    // Not "shrink the desk until the FX strip fits", which ends in controls too small for a thumb.
    // The desk is taller than 390px and always will be; it scrolls, at full size.
    const block = css("mobile.css").split(`@media ${LANDSCAPE_PHONE_QUERY} {`)[1] ?? "";
    expect(block).toContain("flex-direction: row");
    expect(block).toContain("overflow-y: auto");
  });
});
