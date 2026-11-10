import { describe, expect, it } from "vitest";
import { createInnertubeApi, fromMusicItem, hasExplicitBadge } from "./innertube";

// Search returns one row per recording, and the uncensored one (operator, 2026-11-10). The shapes
// below are what youtubei.js hands back for the YouTube Music song shelf, as captured live the same
// day for "cardi b wap": two "WAP (feat. Megan Thee Stallion)" rows by Cardi B at 188 s, one with
// the MUSIC_EXPLICIT_BADGE and one without (the clean cut).

const EXPLICIT = [{ icon_type: "MUSIC_EXPLICIT_BADGE", label: "Explicit" }];
const song = (id: string, title: string, artist: string, seconds: number, badges?: typeof EXPLICIT) => ({
  item_type: "song",
  id,
  title,
  artists: [{ name: artist }],
  duration: { seconds },
  badges,
});
const video = (id: string, title: string, author: string, seconds: number) => ({
  type: "Video",
  id,
  title: { text: title },
  author: { name: author },
  duration: { seconds },
});

function fakeApi(songs: unknown[], videos: unknown[]) {
  const yt = {
    music: { search: async () => ({ songs: { contents: songs } }) },
    search: async () => ({ results: videos }),
    getPlaylist: async () => ({}),
  };
  return createInnertubeApi({ create: async () => yt } as never);
}

describe("the YouTube Music explicit badge", () => {
  it("is read off a song row", () => {
    expect(hasExplicitBadge({ badges: EXPLICIT })).toBe(true);
    expect(hasExplicitBadge({ badges: [] })).toBe(false);
    expect(hasExplicitBadge({})).toBe(false);
    expect(fromMusicItem(song("tqxRidAWER8", "Without Me", "Eminem", 291, EXPLICIT))!.explicit).toBe(true);
    // No badge → no field at all (absence is not "clean").
    expect("explicit" in fromMusicItem(song("2wCSP1fyOWA", "Without Me", "The Soul Jazz Era", 322))!).toBe(false);
  });
});

describe("searchYouTube — one row per recording, uncensored first", () => {
  it("the badged WAP replaces its clean twin, even as the single top hit", async () => {
    const api = fakeApi(
      [
        song("Y3SKjM_2M5k", "WAP (feat. Megan Thee Stallion)", "Cardi B", 188), // the clean cut, listed first
        song("-tmSSWl-ZoA", "WAP (feat. Megan Thee Stallion)", "Cardi B", 188, EXPLICIT),
        song("FOR2vlKg4Hk", "Get Up 10", "Cardi B", 232, EXPLICIT),
      ],
      [],
    );
    const top = await api.searchYouTube("cardi b wap", 1);
    expect(top.map((t) => t.videoId)).toEqual(["-tmSSWl-ZoA"]);
    const all = await api.searchYouTube("cardi b wap", 25);
    expect(all.map((t) => t.videoId)).toEqual(["-tmSSWl-ZoA", "FOR2vlKg4Hk"]);
  });

  it("video-search uploads of a shelf song fold into it; a censored-only song stays", async () => {
    const api = fakeApi(
      [song("2PpBU7EfiEY", "Headlock", "Imogen Heap", 216)],
      [
        video("aaaaaaaaaa1", "Imogen Heap - Headlock (Official Video)", "ImogenHeapVEVO", 215),
        video("aaaaaaaaaa2", "Imogen Heap - Headlock (Lyrics)", "7clouds", 215),
        video("aaaaaaaaaa3", "Imogen Heap - Hide and Seek (Clean)", "Imogen Heap", 268),
        video("aaaaaaaaaa4", "Headlock (Club Mix)", "Imogen Heap", 300),
      ],
    );
    const r = await api.searchYouTube("headlock", 25);
    expect(r.map((t) => t.videoId)).toEqual(["2PpBU7EfiEY", "aaaaaaaaaa3", "aaaaaaaaaa4"]);
  });
});
