import { describe, it, expect } from "vitest";
import { sourceTrackKey, resyncNeedsMatch, reconcileResync, type SourceLike } from "./resync";

// The re-sync reconciliation for fuzzy-matched (Spotify/TIDAL) playlists. The bug this guards:
// re-sync used to dedup by the MATCHED YouTube videoId, but a re-match drifts to a different video
// for the same song across runs — so the song was added again as "new" and the old copy was never
// pruned. Playlists grew forever. Following SOURCE identity instead fixes it; the other half is that
// a prune must never fire on incomplete data (a truncated read, a transient match miss, a manual add).

const src = (p: Partial<SourceLike>): SourceLike => ({
  title: "T",
  artist: "A",
  isrc: null,
  spotifyId: null,
  videoId: null,
  ...p,
});

describe("sourceTrackKey", () => {
  it("prefers ISRC (the cross-service anchor)", () => {
    expect(sourceTrackKey(src({ isrc: "usum71903495", spotifyId: "abc" }))).toBe("isrc:USUM71903495");
  });

  it("falls back to the provider id when there's no ISRC", () => {
    expect(sourceTrackKey(src({ spotifyId: "abc123" }))).toBe("spotify:abc123");
  });

  it("falls back to normalized artist|title when there's neither", () => {
    expect(sourceTrackKey(src({ artist: " Daft Punk ", title: "Around The World" }))).toBe(
      "q:daft punk|around the world",
    );
  });

  it("is STABLE for the same song regardless of which video it matched to", () => {
    // The whole point: identity comes from the source row, not the matched video.
    const a = sourceTrackKey(src({ isrc: "GB1234567890" }));
    const b = sourceTrackKey(src({ isrc: "GB1234567890", title: "different-casing-of-title" }));
    expect(a).toBe(b);
  });

  it("distinguishes two different songs that both lack anchors", () => {
    expect(sourceTrackKey(src({ artist: "X", title: "One" }))).not.toBe(sourceTrackKey(src({ artist: "X", title: "Two" })));
  });
});

describe("resyncNeedsMatch", () => {
  const keyOf = (s: SourceLike) => sourceTrackKey(s);

  it("skips songs whose mapped video we still hold (no re-match, no drift)", () => {
    const s = src({ isrc: "AA0000000001" });
    const need = resyncNeedsMatch([s], keyOf, { "isrc:AA0000000001": "vidA" }, new Set(["vidA"]));
    expect(need).toEqual([]);
  });

  it("re-matches a song whose mapped video is gone from the playlist", () => {
    const s = src({ isrc: "AA0000000001" });
    const need = resyncNeedsMatch([s], keyOf, { "isrc:AA0000000001": "vidA" }, new Set([]));
    expect(need).toEqual([s]);
  });

  it("matches a brand-new source song", () => {
    const s = src({ isrc: "NEW000000001" });
    expect(resyncNeedsMatch([s], keyOf, {}, new Set(["vidA"]))).toEqual([s]);
  });
});

describe("reconcileResync", () => {
  it("does NOT accrete a duplicate when a song re-matches to a different video", () => {
    // The regression: song X was matched to vidA; this run it matches to vidB. Old behaviour added
    // vidB and kept vidA forever. Now vidB is added and the stale vidA is pruned — the song stays once.
    const r = reconcileResync({
      oldMap: { "isrc:X": "vidA" },
      currentIds: new Set(["vidA"]),
      sourceKeys: ["isrc:X"],
      matched: { "isrc:X": "vidB" }, // re-matched (vidA was gone / drifted)
      truncated: false,
    });
    expect(r.addIds).toEqual(["vidB"]);
    expect(r.removeIds).toEqual(["vidA"]);
    expect(r.newMap).toEqual({ "isrc:X": "vidB" });
  });

  it("a carried song is untouched — no add, no remove, same video", () => {
    const r = reconcileResync({
      oldMap: { "isrc:X": "vidA" },
      currentIds: new Set(["vidA"]),
      sourceKeys: ["isrc:X"],
      matched: {}, // carried → never sent to the matcher
      truncated: false,
    });
    expect(r.addIds).toEqual([]);
    expect(r.removeIds).toEqual([]);
    expect(r.newMap).toEqual({ "isrc:X": "vidA" });
  });

  it("prunes a song genuinely removed from the source (the legitimate nuke)", () => {
    const r = reconcileResync({
      oldMap: { "isrc:X": "vidA", "isrc:Y": "vidB" },
      currentIds: new Set(["vidA", "vidB"]),
      sourceKeys: ["isrc:X"], // Y is gone from the source
      matched: {},
      truncated: false,
    });
    expect(r.removeIds).toEqual(["vidB"]);
    expect(r.newMap).toEqual({ "isrc:X": "vidA" });
  });

  it("clearing the whole source prunes everything — the user IS allowed to nuke", () => {
    const r = reconcileResync({
      oldMap: { "isrc:X": "vidA", "isrc:Y": "vidB" },
      currentIds: new Set(["vidA", "vidB"]),
      sourceKeys: [], // source emptied (caller still guards a 0-length READ separately)
      matched: {},
      truncated: false,
    });
    expect(r.removeIds.sort()).toEqual(["vidA", "vidB"]);
    expect(r.newMap).toEqual({});
  });

  it("NEVER prunes a manual add (a video that was never source-managed)", () => {
    const r = reconcileResync({
      oldMap: { "isrc:X": "vidA" },
      currentIds: new Set(["vidA", "manualVid"]), // manualVid is in the playlist but not in the map
      sourceKeys: ["isrc:X"],
      matched: {},
      truncated: false,
    });
    expect(r.removeIds).toEqual([]); // manualVid survives
  });

  it("a transient match MISS does not prune the song", () => {
    // Source still lists X, but this run's matcher returned nothing for it. Its video is still ours
    // (carried), so it must survive — a flaky match must never delete music.
    const r = reconcileResync({
      oldMap: { "isrc:X": "vidA" },
      currentIds: new Set(["vidA"]),
      sourceKeys: ["isrc:X"],
      matched: {}, // matcher produced nothing this run
      truncated: false,
    });
    expect(r.removeIds).toEqual([]);
    expect(r.newMap).toEqual({ "isrc:X": "vidA" });
  });

  it("a TRUNCATED read prunes nothing and preserves the unseen tail", () => {
    // The Tidal page guard caps a huge playlist: we only saw X. Y is beyond the cap — it must NOT be
    // pruned, and its map entry must survive so the next full read still knows about it.
    const r = reconcileResync({
      oldMap: { "isrc:X": "vidA", "isrc:Y": "vidB" },
      currentIds: new Set(["vidA", "vidB"]),
      sourceKeys: ["isrc:X"], // truncated — Y was never read
      matched: {},
      truncated: true,
    });
    expect(r.removeIds).toEqual([]);
    expect(r.newMap).toEqual({ "isrc:X": "vidA", "isrc:Y": "vidB" }); // tail's mapping preserved
  });

  it("a truncated read still ADDS newly-seen songs", () => {
    const r = reconcileResync({
      oldMap: { "isrc:Y": "vidB" },
      currentIds: new Set(["vidB"]),
      sourceKeys: ["isrc:X"],
      matched: { "isrc:X": "vidNew" },
      truncated: true,
    });
    expect(r.addIds).toEqual(["vidNew"]);
    expect(r.removeIds).toEqual([]);
    expect(r.newMap).toEqual({ "isrc:X": "vidNew", "isrc:Y": "vidB" });
  });

  it("does not re-add a match we already hold (dedup against the playlist)", () => {
    const r = reconcileResync({
      oldMap: {},
      currentIds: new Set(["vidA"]), // already in the playlist (e.g. a legacy pre-map import)
      sourceKeys: ["isrc:X"],
      matched: { "isrc:X": "vidA" }, // re-matched to the SAME video we already have
      truncated: false,
    });
    expect(r.addIds).toEqual([]);
    expect(r.newMap).toEqual({ "isrc:X": "vidA" });
  });

  it("legacy playlist (no map) builds a map and prunes nothing", () => {
    // First re-sync after the upgrade: oldMap is empty, so there's nothing to prune — the existing
    // tracks are left alone and the map is seeded from this run's matches.
    const r = reconcileResync({
      oldMap: {},
      currentIds: new Set(["oldVid1", "oldVid2"]),
      sourceKeys: ["isrc:X"],
      matched: { "isrc:X": "vidNew" },
      truncated: false,
    });
    expect(r.removeIds).toEqual([]); // legacy tracks are never nuked by the migration
    expect(r.addIds).toEqual(["vidNew"]);
    expect(r.newMap).toEqual({ "isrc:X": "vidNew" });
  });
});
