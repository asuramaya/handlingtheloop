import { describe, it, expect } from "vitest";
import {
  parseDuration,
  parseViews,
  runsText,
  normalize,
  fromMusicItem,
  fromCompact,
  fromLockup,
  lockupIsMusic,
  collectVideos,
  MAX_TRACK_SECONDS,
} from "./innertube";
import type { TrackMeta } from "./youtube";

// These parsers feed MAX_TRACK_SECONDS filtering and gate videoId resolution for
// the anonymous innertube path (search + watch-next). Malformed input must
// degrade to a safe 0 / null and never throw.

const VALID_ID = "abcdEFGH-_1"; // 11 chars, all [\w-]
const TOO_LONG_SEC = MAX_TRACK_SECONDS + 1;

describe("parseDuration", () => {
  it("m:ss -> seconds", () => {
    expect(parseDuration("3:42")).toBe(222);
  });
  it("h:mm:ss -> seconds", () => {
    expect(parseDuration("1:02:03")).toBe(3723);
  });
  it("0:00 -> 0", () => {
    expect(parseDuration("0:00")).toBe(0);
  });
  it("bare seconds (no colon) -> that number", () => {
    expect(parseDuration("90")).toBe(90);
  });
  it("empty string -> 0", () => {
    expect(parseDuration("")).toBe(0);
  });
  it("undefined -> 0", () => {
    expect(parseDuration(undefined)).toBe(0);
  });
  it("non-numeric -> 0 (NaN guard)", () => {
    expect(parseDuration("abc")).toBe(0);
  });
  it("non-numeric segment -> 0 (NaN guard)", () => {
    expect(parseDuration("3:xx")).toBe(0);
  });
  // NOTE (quirk): a trailing colon yields an empty segment, and Number("") === 0,
  // NOT NaN — so "3:" parses as 3*60+0 = 180s rather than 0. Harmless for real
  // YouTube length strings (always well-formed) but documenting the surprise.
  it("trailing colon (3:) -> 180, not 0 (Number('') is 0)", () => {
    expect(parseDuration("3:")).toBe(180);
  });
  it("does NOT accept ISO-8601 (PT4M13S) -> 0", () => {
    // split(":") on "PT4M13S" -> ["PT4M13S"] -> Number(...) NaN -> 0.
    expect(parseDuration("PT4M13S")).toBe(0);
  });
  it("never throws", () => {
    expect(() => parseDuration(":::")).not.toThrow();
  });
});

describe("parseViews", () => {
  it("1.2M -> 1200000", () => {
    expect(parseViews("1.2M")).toBe(1200000);
  });
  it("500K -> 500000", () => {
    expect(parseViews("500K")).toBe(500000);
  });
  it("3B -> 3000000000", () => {
    expect(parseViews("3B")).toBe(3000000000);
  });
  it("plain digits with commas -> stripped int", () => {
    expect(parseViews("1,234,567")).toBe(1234567);
  });
  it("plain digits -> int", () => {
    expect(parseViews("42")).toBe(42);
  });
  it("case-insensitive suffix (1.5k) -> 1500", () => {
    expect(parseViews("1.5k")).toBe(1500);
  });
  it("ignores trailing words ('1.2M views') -> 1200000", () => {
    expect(parseViews("1.2M views")).toBe(1200000);
  });
  it("empty string -> null", () => {
    expect(parseViews("")).toBeNull();
  });
  it("undefined -> null", () => {
    expect(parseViews(undefined)).toBeNull();
  });
  it("no leading number ('No views') -> null", () => {
    expect(parseViews("No views")).toBeNull();
  });

  // NOTE (possible weirdness): the regex is [\d.]+, so a string that is JUST a dot
  // matches m[1]="." -> Number(".") is NaN -> Math.round(NaN) is NaN. parseViews
  // returns NaN (not null) here. Flagging rather than asserting it is "correct".
  it("a lone dot returns NaN (documented quirk, not a crash)", () => {
    expect(Number.isNaN(parseViews(".") as number)).toBe(true);
  });
});

describe("runsText", () => {
  it("joins run text segments", () => {
    expect(runsText([{ text: "Hello " }, { text: "World" }])).toBe("Hello World");
  });
  it("missing .text segments become empty", () => {
    expect(runsText([{ text: "A" }, {}, { text: "B" }])).toBe("AB");
  });
  it("empty array -> undefined (no empty string)", () => {
    expect(runsText([])).toBeUndefined();
  });
  it("non-array -> undefined", () => {
    expect(runsText(undefined)).toBeUndefined();
    expect(runsText("nope")).toBeUndefined();
    expect(runsText({})).toBeUndefined();
  });
  it("array of all-empty text -> undefined (falsy join)", () => {
    expect(runsText([{ text: "" }, {}])).toBeUndefined();
  });
});

describe("normalize (AnyNode -> TrackMeta)", () => {
  it("valid node -> TrackMeta with videoId/title/duration", () => {
    const t = normalize({
      id: VALID_ID,
      title: { text: "Song Title" },
      author: { name: "Artist" },
      duration: { seconds: 200 },
      thumbnails: [{ url: "small.jpg" }, { url: "large.jpg" }],
      view_count: { text: "1.2M" },
    });
    expect(t).not.toBeNull();
    expect(t!.videoId).toBe(VALID_ID);
    expect(t!.title).toBe("Song Title");
    expect(t!.artist).toBe("Artist");
    expect(t!.duration).toBe(200);
    expect(t!.thumbnail).toBe(`/api/art/${VALID_ID}`); // always same-origin R2 art, not the provider URL
    expect(t!.views).toBe(1200000);
  });
  it("falls back to duration.text when seconds absent", () => {
    const t = normalize({ id: VALID_ID, duration: { text: "3:42" } });
    expect(t!.duration).toBe(222);
  });
  it("title defaults to videoId; synth thumbnail when none", () => {
    const t = normalize({ id: VALID_ID });
    expect(t!.title).toBe(VALID_ID);
    expect(t!.artist).toBe("");
    expect(t!.thumbnail).toBe(`/api/art/${VALID_ID}`);
    expect(t!.views).toBeNull();
  });
  it("missing id -> null", () => {
    expect(normalize({})).toBeNull();
  });
  it("10-char id fails the 11-char guard -> null", () => {
    expect(normalize({ id: "abcdEFGH-_" })).toBeNull();
  });
  it("12-char id fails the 11-char guard -> null", () => {
    expect(normalize({ id: "abcdEFGH-_12" })).toBeNull();
  });
  it("id with an illegal char (.) -> null", () => {
    expect(normalize({ id: "abcdEFGH._1" })).toBeNull();
  });
  it("over-long duration -> null (MAX_TRACK_SECONDS backstop)", () => {
    expect(normalize({ id: VALID_ID, duration: { seconds: TOO_LONG_SEC } })).toBeNull();
  });
});

describe("fromMusicItem", () => {
  const base = {
    item_type: "song",
    id: VALID_ID,
    title: "Track",
    duration: { seconds: 180 },
    artists: [{ name: "A" }, { name: "B" }],
  };
  it("a song row -> TrackMeta, artists joined", () => {
    const t = fromMusicItem({ ...base });
    expect(t).not.toBeNull();
    expect(t!.videoId).toBe(VALID_ID);
    expect(t!.title).toBe("Track");
    expect(t!.artist).toBe("A, B");
    expect(t!.duration).toBe(180);
    expect(t!.thumbnail).toBe(`/api/art/${VALID_ID}`);
    expect(t!.views).toBeNull();
  });
  it("non-song item_type -> null", () => {
    expect(fromMusicItem({ ...base, item_type: "video" })).toBeNull();
    expect(fromMusicItem({ ...base, item_type: "album" })).toBeNull();
  });
  it("missing item_type -> null", () => {
    expect(fromMusicItem({ id: VALID_ID, title: "x" })).toBeNull();
  });
  it("missing title -> null", () => {
    expect(fromMusicItem({ item_type: "song", id: VALID_ID })).toBeNull();
  });
  it("bad-length id -> null", () => {
    expect(fromMusicItem({ ...base, id: "short" })).toBeNull();
  });
  it("no duration -> 0 (kept)", () => {
    const t = fromMusicItem({ item_type: "song", id: VALID_ID, title: "x" });
    expect(t!.duration).toBe(0);
  });
  it("over-long duration -> null", () => {
    expect(fromMusicItem({ ...base, duration: { seconds: TOO_LONG_SEC } })).toBeNull();
  });
});

describe("fromCompact (compactVideoRenderer)", () => {
  it("simpleText fields -> TrackMeta", () => {
    const t = fromCompact({
      videoId: VALID_ID,
      title: { simpleText: "Compact Title" },
      lengthText: { simpleText: "3:42" },
      longBylineText: { runs: [{ text: "Channel" }] },
      viewCountText: { simpleText: "1.2M views" },
      thumbnail: { thumbnails: [{ url: "a.jpg" }, { url: "b.jpg" }] },
    });
    expect(t).not.toBeNull();
    expect(t!.videoId).toBe(VALID_ID);
    expect(t!.title).toBe("Compact Title");
    expect(t!.artist).toBe("Channel");
    expect(t!.duration).toBe(222);
    expect(t!.thumbnail).toBe(`/api/art/${VALID_ID}`);
    expect(t!.views).toBe(1200000);
  });
  it("runs fallbacks for title/length/byline", () => {
    const t = fromCompact({
      videoId: VALID_ID,
      title: { runs: [{ text: "Run Title" }] },
      lengthText: { runs: [{ text: "1:00" }] },
      shortBylineText: { runs: [{ text: "ShortChan" }] },
      shortViewCountText: { simpleText: "500K" },
    });
    expect(t!.title).toBe("Run Title");
    expect(t!.duration).toBe(60);
    expect(t!.artist).toBe("ShortChan");
    expect(t!.views).toBe(500000);
  });
  it("title defaults to id; synth thumbnail when none", () => {
    const t = fromCompact({ videoId: VALID_ID });
    expect(t!.title).toBe(VALID_ID);
    expect(t!.artist).toBe("");
    expect(t!.thumbnail).toBe(`/api/art/${VALID_ID}`);
  });
  it("missing videoId -> null", () => {
    expect(fromCompact({})).toBeNull();
  });
  it("bad-length id -> null", () => {
    expect(fromCompact({ videoId: "tooshort" })).toBeNull();
    expect(fromCompact({ videoId: "waytoolongid12" })).toBeNull();
  });
  it("over-long duration -> null", () => {
    expect(fromCompact({ videoId: VALID_ID, lengthText: { simpleText: "10:00:00" } })).toBeNull();
  });
});

describe("lockupIsMusic", () => {
  it("node carrying imageName:MUSIC -> true", () => {
    expect(lockupIsMusic({ a: { b: { imageName: "MUSIC" } } })).toBe(true);
  });
  it("inside an array -> true", () => {
    expect(lockupIsMusic([{ x: 1 }, { imageName: "MUSIC" }])).toBe(true);
  });
  it("no MUSIC badge -> false", () => {
    expect(lockupIsMusic({ a: { b: { imageName: "GAMING" } } })).toBe(false);
  });
  it("non-object inputs -> false", () => {
    expect(lockupIsMusic(null)).toBe(false);
    expect(lockupIsMusic(undefined)).toBe(false);
    expect(lockupIsMusic("MUSIC")).toBe(false); // a bare string is not the badge
    expect(lockupIsMusic(42)).toBe(false);
  });
  it("depth limit: a deeply nested object does not blow the stack", () => {
    // Build ~1000 levels deep; the depth>25 guard means it simply returns false.
    let deep: Record<string, unknown> = { imageName: "MUSIC" };
    for (let i = 0; i < 1000; i++) deep = { child: deep };
    expect(() => lockupIsMusic(deep)).not.toThrow();
    expect(lockupIsMusic(deep)).toBe(false); // badge sits below the depth>25 cutoff
  });
  it("MUSIC within depth limit is found", () => {
    let node: Record<string, unknown> = { imageName: "MUSIC" };
    for (let i = 0; i < 5; i++) node = { child: node };
    expect(lockupIsMusic(node)).toBe(true);
  });
});

describe("fromLockup (lockupViewModel)", () => {
  // A complete, music-tagged video lockup.
  const goodLockup = {
    contentId: VALID_ID,
    contentType: "LOCKUP_CONTENT_TYPE_VIDEO",
    metadata: {
      lockupMetadataViewModel: {
        title: { content: "Lockup Title" },
        metadata: {
          contentMetadataViewModel: {
            metadataRows: [{ metadataParts: [{ text: { content: "Lockup Artist" } }] }],
          },
        },
      },
    },
    contentImage: {
      thumbnailViewModel: {
        overlays: [
          {
            thumbnailBottomOverlayViewModel: {
              badges: [{ thumbnailBadgeViewModel: { text: "3:42" } }],
            },
          },
        ],
      },
    },
    // MUSIC tag lives anywhere in the tree; lockupIsMusic walks for imageName:MUSIC.
    rendererContext: { imageName: "MUSIC" },
  };

  it("valid music video lockup -> TrackMeta", () => {
    const t = fromLockup(goodLockup);
    expect(t).not.toBeNull();
    expect(t!.videoId).toBe(VALID_ID);
    expect(t!.title).toBe("Lockup Title");
    expect(t!.artist).toBe("Lockup Artist");
    expect(t!.duration).toBe(222);
    expect(t!.thumbnail).toBe(`/api/art/${VALID_ID}`);
    expect(t!.views).toBeNull();
  });
  it("bad-length contentId -> null (skips playlist/channel lockups)", () => {
    expect(fromLockup({ ...goodLockup, contentId: "shortid" })).toBeNull();
  });
  it("non-VIDEO contentType -> null", () => {
    expect(fromLockup({ ...goodLockup, contentType: "LOCKUP_CONTENT_TYPE_PLAYLIST" })).toBeNull();
  });
  it("missing MUSIC tag -> null", () => {
    // rendererContext (where the MUSIC tag lives — lockupIsMusic tree-walks for it) isn't on the
    // LockupVM type, so cast the override past the excess-property check.
    expect(fromLockup({ ...goodLockup, rendererContext: { imageName: "OTHER" } } as Parameters<typeof fromLockup>[0])).toBeNull();
  });
  it("missing title -> null (placeholder / current-video echo)", () => {
    const noTitle = {
      ...goodLockup,
      metadata: { lockupMetadataViewModel: { title: {} } },
    };
    expect(fromLockup(noTitle)).toBeNull();
  });
  it("over-long duration badge -> null", () => {
    const longDur = {
      ...goodLockup,
      contentImage: {
        thumbnailViewModel: {
          overlays: [
            {
              thumbnailBottomOverlayViewModel: {
                badges: [{ thumbnailBadgeViewModel: { text: "10:00:00" } }],
              },
            },
          ],
        },
      },
    };
    expect(fromLockup(longDur)).toBeNull();
  });
  it("missing duration badge -> duration 0 (kept)", () => {
    const noBadge = { ...goodLockup, contentImage: undefined };
    const t = fromLockup(noBadge);
    expect(t!.duration).toBe(0);
  });
  it("absent contentType (undefined) is allowed", () => {
    const noType = { ...goodLockup };
    delete (noType as { contentType?: string }).contentType;
    expect(fromLockup(noType)).not.toBeNull();
  });
});

describe("collectVideos", () => {
  it("pushes both a compactVideoRenderer and a lockupViewModel from a mixed tree", () => {
    const ID_A = "compactI-_1"; // 11 chars
    const ID_B = "lockupID_-1"; // 11 chars
    const tree = {
      contents: {
        secondaryResults: [
          { compactVideoRenderer: { videoId: ID_A, title: { simpleText: "Compact" } } },
        ],
        items: [
          {
            lockupViewModel: {
              contentId: ID_B,
              contentType: "LOCKUP_CONTENT_TYPE_VIDEO",
              metadata: { lockupMetadataViewModel: { title: { content: "Lockup" } } },
              badge: { imageName: "MUSIC" },
            },
          },
        ],
      },
    };
    const out: TrackMeta[] = [];
    collectVideos(tree, (t) => out.push(t));
    const ids = out.map((t) => t.videoId);
    expect(ids).toContain(ID_A);
    expect(ids).toContain(ID_B);
    expect(out).toHaveLength(2);
  });

  it("skips renderers that fail their guards (bad id / non-music lockup)", () => {
    const tree = {
      a: { compactVideoRenderer: { videoId: "tooshort" } }, // bad id -> dropped
      b: {
        lockupViewModel: {
          contentId: "validIDxx_1", // 11 chars but...
          metadata: { lockupMetadataViewModel: { title: { content: "T" } } },
          // ...no MUSIC tag -> dropped
        },
      },
    };
    const out: TrackMeta[] = [];
    collectVideos(tree, (t) => out.push(t));
    expect(out).toHaveLength(0);
  });

  it("does not recurse into matched renderer keys, but does find nested ones", () => {
    // A compactVideoRenderer nested under an arbitrary key is still found.
    const ID = "nestedID_-1";
    const tree = { deep: { wrap: [{ compactVideoRenderer: { videoId: ID } }] } };
    const out: TrackMeta[] = [];
    collectVideos(tree, (t) => out.push(t));
    expect(out.map((t) => t.videoId)).toEqual([ID]);
  });

  it("depth limit: deeply nested junk does not throw", () => {
    let deep: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 1000; i++) deep = { child: deep };
    const out: TrackMeta[] = [];
    expect(() => collectVideos(deep, (t) => out.push(t))).not.toThrow();
    expect(out).toHaveLength(0);
  });

  it("non-object / null roots are no-ops", () => {
    const out: TrackMeta[] = [];
    collectVideos(null, (t) => out.push(t));
    collectVideos("string", (t) => out.push(t));
    collectVideos(123, (t) => out.push(t));
    expect(out).toHaveLength(0);
  });
});
