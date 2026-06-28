// Locks down the worker videoId/title helpers (worker/shared.ts): isVideoId (the
// 11-char YouTube id guard that gates the R2 keyspace and resolver) and cleanVideoTitle
// (strips uploader title junk before catalog name-matching).
import { describe, expect, it } from "vitest";
import { isVideoId, cleanVideoTitle } from "./shared";

describe("isVideoId", () => {
  it("accepts exactly 11 chars from [\\w-]", () => {
    expect(isVideoId("dQw4w9WgXcQ")).toBe(true);
    expect(isVideoId("abc-def_123")).toBe(true); // hyphen + underscore are allowed
    expect(isVideoId("___________")).toBe(true); // 11 underscores
    expect(isVideoId("-----------")).toBe(true); // 11 hyphens
  });

  it("rejects 10 chars (too short) and 12 chars (too long)", () => {
    expect(isVideoId("dQw4w9WgXc")).toBe(false); // 10
    expect(isVideoId("dQw4w9WgXcQQ")).toBe(false); // 12
  });

  it("rejects empty string and null", () => {
    expect(isVideoId("")).toBe(false);
    expect(isVideoId(null)).toBe(false);
  });

  it("rejects 11-length strings containing chars outside [\\w-]", () => {
    expect(isVideoId("dQw4w9WgX.Q")).toBe(false); // dot
    expect(isVideoId("dQw4w9Wg cQ")).toBe(false); // space
    expect(isVideoId("dQw4w9WgX/Q")).toBe(false); // slash
    expect(isVideoId("dQw4w9WgX!Q")).toBe(false); // punctuation
  });
});

describe("cleanVideoTitle", () => {
  it("strips a junk-only parenthetical (official video)", () => {
    expect(cleanVideoTitle("Artist - Song (Official Video)")).toBe("Artist - Song");
  });

  it("strips a junk-only bracket ([HD], [4K])", () => {
    expect(cleanVideoTitle("Artist - Song [HD]")).toBe("Artist - Song");
    expect(cleanVideoTitle("Artist - Song (Lyrics) [4K]")).toBe("Artist - Song");
  });

  it("strips the various TITLE_JUNK markers in parens", () => {
    expect(cleanVideoTitle("Song (Official Audio)")).toBe("Song");
    expect(cleanVideoTitle("Song (Visualizer)")).toBe("Song");
    expect(cleanVideoTitle("Song (Explicit)")).toBe("Song");
    expect(cleanVideoTitle("Song (MV)")).toBe("Song");
    expect(cleanVideoTitle("Song (720p)")).toBe("Song");
  });

  it("strips the bare 'official music video' / 'official audio' phrase forms", () => {
    expect(cleanVideoTitle("Song Official Music Video")).toBe("Song");
    expect(cleanVideoTitle("Song Official Audio")).toBe("Song");
  });

  it("strips a '|| HD ...' tail", () => {
    expect(cleanVideoTitle("Song || HD remaster")).toBe("Song");
  });

  it("removes a trailing dangling dash left behind", () => {
    expect(cleanVideoTitle("Song -")).toBe("Song");
  });

  it("leaves a clean title untouched", () => {
    expect(cleanVideoTitle("Artist - Song")).toBe("Artist - Song");
  });

  it("preserves a meaningful parenthetical that is NOT pure junk", () => {
    // The paren contains real content ("Live at Wembley"), so TITLE_JUNK.test(m)
    // matches only on the junk word but the replace passes the whole group through
    // unless it's junk-only... here 'live'/'at'/'wembley' aren't TITLE_JUNK tokens,
    // so the group is kept verbatim.
    expect(cleanVideoTitle("Song (Live at Wembley)")).toBe("Song (Live at Wembley)");
  });
});
