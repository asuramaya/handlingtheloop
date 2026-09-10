import { describe, expect, it } from "vitest";
import { migrateMembership, migratePlaylists, needsMigration, type StoredPlaylist } from "./playlistKeys";
import { trackKey } from "./identity";
import type { TrackMeta } from "./types";

const yt = (videoId: string, title = videoId): TrackMeta =>
  ({ videoId, title, artist: "A", duration: 100 }) as TrackMeta;

const catalog = (providerId: string, title: string): TrackMeta =>
  ({ videoId: "", title, artist: "A", duration: 100, provider: "spotify", providerId }) as TrackMeta;

const pl = (over: Partial<StoredPlaylist> = {}): StoredPlaylist => ({
  id: "pl_1",
  name: "P",
  ...over,
});

describe("migrateMembership", () => {
  it("translates ids the collection can identify", () => {
    const c = [yt("aaaaaaaaaaa"), yt("bbbbbbbbbbb")];
    expect(migrateMembership(["aaaaaaaaaaa", "bbbbbbbbbbb"], c)).toEqual(["yt:aaaaaaaaaaa", "yt:bbbbbbbbbbb"]);
  });

  it("agrees with trackKey itself — the migration must not invent a second identity", () => {
    const t = yt("aaaaaaaaaaa");
    expect(migrateMembership(["aaaaaaaaaaa"], [t])).toEqual([trackKey(t)]);
  });

  it("PRESERVES a member the collection cannot identify, in the collection's own namespace", () => {
    // The track was removed from the collection but kept in the list. Dropping it would
    // silently shorten the user's playlist; the yt: form is what trackKey gives it on return.
    expect(migrateMembership(["ccccccccccc"], [])).toEqual(["yt:ccccccccccc"]);
  });

  it("keeps order and duplicates exactly as stored", () => {
    const c = [yt("aaaaaaaaaaa"), yt("bbbbbbbbbbb")];
    expect(migrateMembership(["bbbbbbbbbbb", "aaaaaaaaaaa", "bbbbbbbbbbb"], c)).toEqual([
      "yt:bbbbbbbbbbb",
      "yt:aaaaaaaaaaa",
      "yt:bbbbbbbbbbb",
    ]);
  });

  it("does not collapse distinct unresolved catalog tracks onto the shared empty videoId", () => {
    // The exact bug trackKey exists to kill: two Spotify rows both carry videoId "".
    const one = catalog("s1", "One");
    const two = catalog("s2", "Two");
    expect(trackKey(one)).not.toEqual(trackKey(two));
    // "" must never enter the index, so it can never translate a member either.
    expect(migrateMembership([""], [one, two])).toEqual(["yt:"]);
  });
});

describe("migratePlaylists", () => {
  it("is idempotent — a second run changes nothing", () => {
    const c = [yt("aaaaaaaaaaa")];
    const once = migratePlaylists([pl({ trackIds: ["aaaaaaaaaaa"] })], c);
    const twice = migratePlaylists(once, c);
    expect(twice).toEqual(once);
    expect(once[0].trackKeys).toEqual(["yt:aaaaaaaaaaa"]);
  });

  it("drops the legacy field so no reader can pick the stale one", () => {
    const out = migratePlaylists([pl({ trackIds: ["aaaaaaaaaaa"] })], [yt("aaaaaaaaaaa")]);
    expect("trackIds" in out[0]).toBe(false);
  });

  it("leaves an already-migrated playlist untouched even beside a legacy sibling", () => {
    const c = [yt("aaaaaaaaaaa")];
    const out = migratePlaylists(
      [pl({ id: "new", trackKeys: ["isrc:XYZ"] }), pl({ id: "old", trackIds: ["aaaaaaaaaaa"] })],
      c,
    );
    expect(out[0].trackKeys).toEqual(["isrc:XYZ"]);
    expect(out[1].trackKeys).toEqual(["yt:aaaaaaaaaaa"]);
  });

  it("migrates sourceMatch VALUES and leaves its KEYS alone", () => {
    // Keys are source-side identities (isrc/spotifyId); values are matched videoIds. If the
    // values stay videoIds while membership becomes trackKeys, re-sync dedup compares across
    // two id spaces, never matches, and re-accretes duplicates forever.
    const c = [yt("aaaaaaaaaaa")];
    const out = migratePlaylists(
      [pl({ trackIds: ["aaaaaaaaaaa"], sourceMatch: { "isrc:XYZ": "aaaaaaaaaaa" } })],
      c,
    );
    expect(out[0].sourceMatch).toEqual({ "isrc:XYZ": "yt:aaaaaaaaaaa" });
  });

  it("gives a playlist with neither field an empty membership, not undefined", () => {
    const out = migratePlaylists([pl()], []);
    expect(out[0].trackKeys).toEqual([]);
  });

  it("needsMigration is false once trackKeys exists, true only for the legacy shape", () => {
    expect(needsMigration(pl({ trackIds: [] }))).toBe(true);
    expect(needsMigration(pl({ trackKeys: [] }))).toBe(false);
    expect(needsMigration(pl({ trackKeys: [], trackIds: ["x"] }))).toBe(false);
    expect(needsMigration(pl())).toBe(false);
  });
});
