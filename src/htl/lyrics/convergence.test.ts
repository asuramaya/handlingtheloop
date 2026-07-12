import { describe, it, expect } from "vitest";
import { planLyrics, looksDegenerate } from "./convergence";
import type { LyricsLine } from "./types";

const line = (text: string, start = 0): LyricsLine => ({ start, end: start + 1, text });
const lines = (...texts: string[]): LyricsLine[] => texts.map((t, i) => line(t, i));

// The client's current format. Kept local to the test on purpose: these rules must hold for ANY
// version pair, not just today's numbers.
const V = 4;

describe("planLyrics — reuse iff the stored format is at least ours", () => {
  it("nothing anywhere, and we can decode → decode, show nothing", () => {
    expect(planLyrics({ local: null, pooled: null, clientVer: V, canDecode: true })).toEqual({
      show: null,
      decode: true,
      adoptPool: false,
    });
  });

  it("nothing anywhere, and we CAN'T decode → show nothing, don't decode (the phone case)", () => {
    expect(planLyrics({ local: null, pooled: null, clientVer: V, canDecode: false })).toEqual({
      show: null,
      decode: false,
      adoptPool: false,
    });
  });

  it("a current local copy → show it and STOP (the decode-once invariant)", () => {
    expect(planLyrics({ local: V, pooled: null, clientVer: V, canDecode: true })).toEqual({
      show: "local",
      decode: false,
      adoptPool: false,
    });
  });

  it("a STALE local copy on a capable device → show it, and re-decode to upgrade", () => {
    expect(planLyrics({ local: 2, pooled: null, clientVer: V, canDecode: true })).toEqual({
      show: "local",
      decode: true,
      adoptPool: false,
    });
  });

  it("★ a stale local copy on a device that CAN'T decode → show it anyway, never decode", () => {
    // Stale lyrics beat no lyrics. The phone keeps what it has and waits for some desktop GPU to
    // repair the pool on its behalf — it must not blank the ribbon just because the format is old.
    expect(planLyrics({ local: 2, pooled: null, clientVer: V, canDecode: false })).toEqual({
      show: "local",
      decode: false,
      adoptPool: false,
    });
  });

  it("★ a CURRENT pooled row beats an absent local one → adopt it, no decode", () => {
    expect(planLyrics({ local: null, pooled: V, clientVer: V, canDecode: true })).toEqual({
      show: "pool",
      decode: false,
      adoptPool: true,
    });
  });

  it("★ THE BUG THIS FIXES: a STALE pooled row does NOT satisfy a capable client", () => {
    // Before migration 0026 the pool had no version, so this row was served, stamped CURRENT in
    // the local cache, and never re-decoded — bumping LYRICS_VER did nothing for pooled tracks.
    // Now it is shown (better than blank) but the client re-decodes and upgrades the row.
    expect(planLyrics({ local: null, pooled: 1, clientVer: V, canDecode: true })).toEqual({
      show: "pool",
      decode: true,
      adoptPool: true,
    });
  });

  it("a pooled row NEWER than our local copy wins and is adopted", () => {
    expect(planLyrics({ local: 2, pooled: 3, clientVer: V, canDecode: true })).toEqual({
      show: "pool",
      decode: true, // 3 is still behind this client's 4 → keep upgrading
      adoptPool: true,
    });
  });

  it("a pooled row OLDER than our local copy is ignored entirely", () => {
    expect(planLyrics({ local: 3, pooled: 1, clientVer: V, canDecode: true })).toEqual({
      show: "local",
      decode: true,
      adoptPool: false,
    });
  });

  it("an EQUAL pooled row is not adopted — a tie is not worth rewriting the local record", () => {
    expect(planLyrics({ local: V, pooled: V, clientVer: V, canDecode: true })).toEqual({
      show: "local",
      decode: false,
      adoptPool: false,
    });
  });

  it("★ a copy NEWER than this client (written by a future build) is reused, never 'downgraded'", () => {
    // The old local gate was `rec.ver !== LYRICS_VER`, which threw away a NEWER record and
    // re-decoded it with older logic — actively undoing an upgrade. The rule is >=, not ==.
    expect(planLyrics({ local: 9, pooled: null, clientVer: V, canDecode: true })).toEqual({
      show: "local",
      decode: false,
      adoptPool: false,
    });
    expect(planLyrics({ local: null, pooled: 9, clientVer: V, canDecode: true })).toEqual({
      show: "pool",
      decode: false,
      adoptPool: true,
    });
  });

  it("converges: re-planning after the upgrade lands is a no-op (no decode loop)", () => {
    const first = planLyrics({ local: 1, pooled: 1, clientVer: V, canDecode: true });
    expect(first.decode).toBe(true);
    // ...the decode writes LYRICS_VER locally and to the pool. Next load:
    const second = planLyrics({ local: V, pooled: V, clientVer: V, canDecode: true });
    expect(second.decode).toBe(false);
  });
});

describe("looksDegenerate — never publish a loop hallucination to the shared pool", () => {
  it("passes a normal transcript", () => {
    expect(looksDegenerate(lines("one", "two", "three", "four", "five", "six", "seven"))).toBe(false);
  });

  it("★ catches the instrumental loop (one phrase, over and over)", () => {
    expect(looksDegenerate(lines("Thanks for watching!", "Thanks for watching!", "Thanks for watching!", "Thanks for watching!", "Thanks for watching!", "Thanks for watching!"))).toBe(true);
  });

  it("★ catches a near-loop: a couple of phrases smeared over a long transcript", () => {
    const hallucinated = lines(...Array.from({ length: 40 }, (_, i) => (i % 2 ? "subtitles by the amara.org community" : "you")));
    expect(looksDegenerate(hallucinated)).toBe(true);
  });

  it("★ does NOT punish a chorus-heavy song", () => {
    // A real song repeats its hook. 8 distinct lines out of 24 = 0.33, comfortably above the bar.
    const chorus = ["hook", "hook", "hook"];
    const song = lines(...["v1a", "v1b", "v1c", ...chorus, "v2a", "v2b", "v2c", ...chorus, "b1", "b2", ...chorus, "v3a", "v3b", "v3c", ...chorus]);
    expect(looksDegenerate(song)).toBe(false);
  });

  it("never judges a short transcript — a sparse song is legitimately a few lines", () => {
    // A false positive costs a real transcript, so below the threshold we simply don't rule.
    expect(looksDegenerate(lines("hey", "hey", "hey"))).toBe(false);
    expect(looksDegenerate(lines("hey", "hey", "hey", "hey", "hey"))).toBe(false);
  });

  it("ignores case and surrounding whitespace when judging repetition", () => {
    expect(looksDegenerate(lines("Yeah ", "yeah", " YEAH", "Yeah", "yeah ", "YEAH", "yeah"))).toBe(true);
  });

  it("an empty transcript is not degenerate (there is simply nothing to publish)", () => {
    expect(looksDegenerate([])).toBe(false);
  });
});
