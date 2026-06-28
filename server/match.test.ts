// Locks down cross-service track matching (server/match.ts): the normalize/token
// pipeline, jaccard overlap, variant detection, the score weighting + duration
// penalty + variant-mismatch penalty, the confidence tiers, and ranking.
import { describe, expect, it } from "vitest";
import {
  normalize,
  tokens,
  jaccard,
  variants,
  score,
  confidenceOf,
  rank,
  type Candidate,
} from "./match";

describe("normalize", () => {
  it("lowercases", () => {
    expect(normalize("HELLO World")).toBe("hello world");
  });

  it("strips diacritics", () => {
    expect(normalize("Beyoncé")).toBe("beyonce");
    expect(normalize("Café")).toBe("cafe");
  });

  it("removes noise words (official/video/lyrics/audio/etc.)", () => {
    expect(normalize("Song Official Video")).toBe("song");
    expect(normalize("Song Lyrics")).toBe("song");
    expect(normalize("Song HD HQ Audio")).toBe("song");
    // feat./ft./prod. are noise too
    expect(normalize("Song feat. Drake")).toBe("song drake");
  });

  it("strips parenthetical and bracketed content entirely", () => {
    expect(normalize("Song (Some Subtitle)")).toBe("song");
    expect(normalize("Song [Anything Here]")).toBe("song");
  });

  it("collapses runs of whitespace/punctuation to single spaces and trims", () => {
    expect(normalize("  a   --  b  ")).toBe("a b");
    expect(normalize("a,b;c")).toBe("a b c");
  });

  it("combines all passes on a realistic uploader title", () => {
    expect(normalize("Café (Official Video) [HD] - Lyrics")).toBe("cafe");
  });

  it("handles empty / falsy input without throwing", () => {
    expect(normalize("")).toBe("");
    // @ts-expect-error exercising the `s || ""` guard
    expect(normalize(undefined)).toBe("");
  });
});

describe("tokens", () => {
  it("splits into a set of distinct normalized words", () => {
    expect(tokens("Hello Hello World")).toEqual(new Set(["hello", "world"]));
  });

  it("drops noise/empty so only meaningful tokens remain", () => {
    expect(tokens("Song (Official Video)")).toEqual(new Set(["song"]));
  });
});

describe("jaccard", () => {
  it("is 0 for two disjoint sets", () => {
    expect(jaccard(new Set(["a", "b"]), new Set(["c", "d"]))).toBe(0);
  });

  it("is 1 for identical sets", () => {
    expect(jaccard(new Set(["a", "b"]), new Set(["a", "b"]))).toBe(1);
  });

  it("is a known partial: |∩|=2, |∪|=4 → 0.5", () => {
    expect(jaccard(new Set(["a", "b", "c"]), new Set(["b", "c", "d"]))).toBe(0.5);
  });

  it("is 0 when either set is empty (the guard)", () => {
    expect(jaccard(new Set(), new Set(["a"]))).toBe(0);
    expect(jaccard(new Set(["a"]), new Set())).toBe(0);
  });
});

describe("variants", () => {
  it("detects live/remix markers, normalizing whitespace inside the marker", () => {
    expect(variants("Song (Live Remix)")).toEqual(new Set(["live", "remix"]));
  });

  it("detects cover / acoustic / instrumental", () => {
    expect(variants("Song Acoustic Cover")).toEqual(new Set(["acoustic", "cover"]));
  });

  it("detects 'sped up' (with the internal space stripped) and 'slowed'", () => {
    expect(variants("Track sped up")).toEqual(new Set(["spedup"]));
    expect(variants("Track slowed reverb")).toEqual(new Set(["slowed", "reverb"]));
  });

  it("is empty for a plain title", () => {
    expect(variants("Bohemian Rhapsody")).toEqual(new Set());
  });
});

describe("score", () => {
  const queen = { title: "Bohemian Rhapsody", artist: "Queen", duration: 355 };

  it("scores an identical pair at the top (1) → high confidence", () => {
    const s = score(queen, { ...queen });
    expect(s).toBe(1);
    expect(confidenceOf(s)).toBe("high");
  });

  it("scores a wholly unrelated pair at 0 → none", () => {
    const s = score(queen, { title: "Baby Shark", artist: "Pinkfong", duration: 60 });
    expect(s).toBe(0);
    expect(confidenceOf(s)).toBe("none");
  });

  it("weights title (0.65) over artist (0.35): same title, wrong artist still scores well", () => {
    // title jaccard = 1, artist jaccard = 0, no duration → 0.65
    const s = score(
      { title: "Hello World", artist: "Adele", duration: 0 },
      { title: "Hello World", artist: "SomeoneElse", duration: 0 },
    );
    expect(s).toBeCloseTo(0.65, 10);
  });

  describe("duration penalty around the ±20s boundary", () => {
    const base = { title: "Hello World", artist: "Adele", duration: 100 };
    const titleArtistOnly = 1; // identical title+artist → base name score 1

    it("0s difference applies no penalty (durFactor=1)", () => {
      expect(score(base, { ...base, duration: 100 })).toBe(1);
    });

    it("10s difference → durFactor 0.5 → 0.7+0.3*0.5 = 0.85", () => {
      expect(score(base, { ...base, duration: 110 })).toBeCloseTo(0.85, 10);
    });

    it("at exactly 20s the durFactor hits 0 → floor multiplier 0.7", () => {
      expect(score(base, { ...base, duration: 120 })).toBeCloseTo(0.7, 10);
    });

    it("beyond 20s stays clamped at the 0.7 floor (Math.max(0,...))", () => {
      expect(score(base, { ...base, duration: 140 })).toBeCloseTo(0.7, 10);
    });

    it("the penalty only applies when BOTH durations are known (>0)", () => {
      // src duration unknown → no duration multiplier even though cand has one
      expect(
        score({ ...base, duration: 0 }, { ...base, duration: 999 }),
      ).toBe(titleArtistOnly);
    });
  });

  describe("variant-mismatch penalty", () => {
    const plain = { title: "Hello", artist: "Adele", duration: 100 };

    it("a candidate variant the source lacks multiplies by 0.6", () => {
      const s = score(plain, { title: "Hello (Live)", artist: "Adele", duration: 100 });
      expect(s).toBeCloseTo(0.6, 10);
    });

    it("no penalty when the source has the same variant marker", () => {
      const s = score(
        { title: "Hello (Live)", artist: "Adele", duration: 100 },
        { title: "Hello (Live)", artist: "Adele", duration: 100 },
      );
      expect(s).toBe(1);
    });

    it("two distinct unrequested variants compound the 0.6 penalty (0.6*0.6)", () => {
      const s = score(plain, { title: "Hello (Live Remix)", artist: "Adele", duration: 100 });
      expect(s).toBeCloseTo(0.36, 10);
    });
  });

  it("always returns a value within [0,1]", () => {
    const s = score(queen, { title: "queen", artist: "bohemian rhapsody", duration: 1000 });
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThanOrEqual(1);
  });
});

describe("confidenceOf tier boundaries", () => {
  it("0.7 is the floor of 'high'", () => {
    expect(confidenceOf(0.7)).toBe("high");
    expect(confidenceOf(0.699999)).toBe("medium");
  });

  it("0.45 is the floor of 'medium'", () => {
    expect(confidenceOf(0.45)).toBe("medium");
    expect(confidenceOf(0.449999)).toBe("low");
  });

  it("0.25 is the floor of 'low'", () => {
    expect(confidenceOf(0.25)).toBe("low");
    expect(confidenceOf(0.249999)).toBe("none");
  });

  it("0 is 'none'", () => {
    expect(confidenceOf(0)).toBe("none");
  });
});

describe("rank", () => {
  const src = { title: "Bohemian Rhapsody", artist: "Queen", duration: 355 };
  const mk = (id: string, title: string, artist: string, duration: number): Candidate => ({
    id,
    kind: "video",
    title,
    artist,
    duration,
    thumbnail: null,
  });

  it("sorts candidates best-first and pairs each with its score", () => {
    const cands = [
      mk("bad", "Baby Shark", "Pinkfong", 60),
      mk("perfect", "Bohemian Rhapsody", "Queen", 355),
      mk("live", "Bohemian Rhapsody (Live)", "Queen", 355),
    ];
    const ranked = rank(src, cands);
    expect(ranked.map((r) => r.cand.id)).toEqual(["perfect", "live", "bad"]);
    // scores are monotonically non-increasing
    for (let i = 1; i < ranked.length; i++) {
      expect(ranked[i - 1].score).toBeGreaterThanOrEqual(ranked[i].score);
    }
    expect(ranked[0].score).toBe(1);
    expect(ranked[2].score).toBe(0);
  });

  it("returns an empty array for no candidates", () => {
    expect(rank(src, [])).toEqual([]);
  });
});
