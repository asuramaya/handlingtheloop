import { describe, expect, it } from "vitest";
import type { TrackMeta } from "./types";
import { canonicalVideoId, canonicalizeTrack, sameTrack, trackKey } from "./identity";

const t = (over: Partial<TrackMeta>): TrackMeta => ({
  videoId: "",
  title: "",
  artist: "",
  duration: 0,
  thumbnail: null,
  views: null,
  ...over,
});

describe("canonicalVideoId", () => {
  it("passes a bare 11-char id through, case preserved (ids are case-sensitive)", () => {
    expect(canonicalVideoId("dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(canonicalVideoId("AbCdEfGhIjK")).toBe("AbCdEfGhIjK"); // not lowercased
  });
  it("extracts the id from every YouTube URL form", () => {
    expect(canonicalVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s")).toBe("dQw4w9WgXcQ");
    expect(canonicalVideoId("https://youtu.be/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(canonicalVideoId("https://www.youtube.com/shorts/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(canonicalVideoId("https://www.youtube.com/embed/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });
  it("trims whitespace", () => {
    expect(canonicalVideoId("  dQw4w9WgXcQ  ")).toBe("dQw4w9WgXcQ");
  });
  it("returns '' for non-YouTube input (an unresolved catalog id)", () => {
    expect(canonicalVideoId("")).toBe("");
    expect(canonicalVideoId(null)).toBe("");
    expect(canonicalVideoId("spotify:track:123")).toBe("");
  });
});

describe("trackKey", () => {
  it("treats a bare id, a URL, and a padded id as the same track", () => {
    const a = t({ videoId: "dQw4w9WgXcQ" });
    const b = t({ videoId: "https://youtu.be/dQw4w9WgXcQ" });
    const c = t({ videoId: " dQw4w9WgXcQ " });
    expect(trackKey(a)).toBe(trackKey(b));
    expect(trackKey(b)).toBe(trackKey(c));
    expect(sameTrack(a, b)).toBe(true);
  });

  it("does NOT collapse two distinct unresolved catalog tracks (the empty-videoId bug)", () => {
    const one = t({ videoId: "", isrc: "USUM71803100", title: "A", artist: "X" });
    const two = t({ videoId: "", isrc: "GBUM71029604", title: "B", artist: "Y" });
    expect(trackKey(one)).not.toBe(trackKey(two));
    expect(sameTrack(one, two)).toBe(false);
  });

  it("dedupes catalog tracks by ISRC regardless of provider id / title noise", () => {
    const spotify = t({ videoId: "", isrc: "usum71803100", provider: "spotify", providerId: "s1", title: "Song" });
    const tidal = t({ videoId: "", isrc: "USUM71803100", provider: "tidal", providerId: "t9", title: "Song (Remaster)" });
    expect(trackKey(spotify)).toBe(trackKey(tidal)); // ISRC case-folded
  });

  it("falls back to provider:id, then to normalized title|artist", () => {
    const byProvider = t({ videoId: "", provider: "spotify", providerId: "abc" });
    expect(trackKey(byProvider)).toBe("spotify:abc");
    const byQuery = t({ videoId: "", title: "  Hello  ", artist: "ADELE" });
    expect(trackKey(byQuery)).toBe("q:adele|hello");
  });

  it("a resolved YouTube id wins over the catalog anchor", () => {
    const resolved = t({ videoId: "dQw4w9WgXcQ", isrc: "USUM71803100" });
    expect(trackKey(resolved)).toBe("yt:dQw4w9WgXcQ");
  });
});

describe("canonicalizeTrack", () => {
  it("rewrites a URL videoId to the bare id but leaves an empty catalog id alone", () => {
    expect(canonicalizeTrack(t({ videoId: "https://youtu.be/dQw4w9WgXcQ" })).videoId).toBe("dQw4w9WgXcQ");
    const cat = t({ videoId: "", isrc: "USUM71803100" });
    expect(canonicalizeTrack(cat)).toBe(cat); // unchanged reference
  });
});
