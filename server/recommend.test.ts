import { describe, test, expect, vi } from "vitest";
import { recommendNext } from "./recommend";
import { fromPlaylistPanel, collectVideos, isNonSong } from "./innertube";
import type { TrackMeta } from "./youtube";

const t = (videoId: string): TrackMeta => ({ videoId, title: videoId, artist: "", duration: 200, thumbnail: null, views: null });
const api = (music: TrackMeta[], watch: TrackMeta[]) => ({
  getMusicRadio: vi.fn(async () => music),
  getWatchNext: vi.fn(async () => watch),
});

describe("recommendNext — tier order", () => {
  test("provider radio leads, then music radio, then the watch-next spine", async () => {
    const a = api([t("music000001")], [t("watch000001")]);
    const out = await recommendNext(a, "seed0000001", { providerRadio: async () => [t("tidal000001")] });
    expect(out.map((x) => x.videoId)).toEqual(["tidal000001", "music000001", "watch000001"]);
  });

  test("the seed is never suggested back, from any tier", async () => {
    const a = api([t("seed0000001")], [t("seed0000001"), t("ok000000001")]);
    const out = await recommendNext(a, "seed0000001");
    expect(out.map((x) => x.videoId)).toEqual(["ok000000001"]);
  });

  test("a candidate appearing in two tiers is only listed once, at its best position", async () => {
    const a = api([t("dupe000001")], [t("dupe000001"), t("other00001")]);
    const out = await recommendNext(a, "seed0000001");
    expect(out.map((x) => x.videoId)).toEqual(["dupe000001", "other00001"]);
  });

  // Every tier is allowed to fail; only the last one is load-bearing.
  test("a throwing provider tier falls through instead of failing the request", async () => {
    const a = api([], [t("floor00001")]);
    const out = await recommendNext(a, "seed0000001", {
      providerRadio: async () => {
        throw new Error("tidal down");
      },
    });
    expect(out.map((x) => x.videoId)).toEqual(["floor00001"]);
  });

  test("a throwing music-radio tier falls through to the spine", async () => {
    const a = {
      getMusicRadio: vi.fn(async () => {
        throw new Error("no radio");
      }),
      getWatchNext: vi.fn(async () => [t("floor00001")]),
    };
    expect((await recommendNext(a, "seed0000001")).map((x) => x.videoId)).toEqual(["floor00001"]);
  });

  test("everything failing yields an empty list, not a rejection", async () => {
    const a = {
      getMusicRadio: vi.fn(async () => {
        throw new Error("x");
      }),
      getWatchNext: vi.fn(async () => {
        throw new Error("y");
      }),
    };
    await expect(recommendNext(a, "seed0000001")).resolves.toEqual([]);
  });

  // The cheap tiers exist to avoid the expensive one; a satisfied limit must stop the cascade.
  test("a tier that already met the limit short-circuits the ones below it", async () => {
    const a = api([t("m000000001"), t("m000000002")], [t("w000000001")]);
    const out = await recommendNext(a, "seed0000001", { limit: 2 });
    expect(out).toHaveLength(2);
    expect(a.getWatchNext).not.toHaveBeenCalled();
  });

  test("an api without getMusicRadio still works (older shape / tests)", async () => {
    const out = await recommendNext({ getWatchNext: async () => [t("w000000001")] }, "seed0000001");
    expect(out.map((x) => x.videoId)).toEqual(["w000000001"]);
  });

  test("skipMusicRadio bypasses the tier", async () => {
    const a = api([t("m000000001")], [t("w000000001")]);
    const out = await recommendNext(a, "seed0000001", { skipMusicRadio: true });
    expect(out.map((x) => x.videoId)).toEqual(["w000000001"]);
    expect(a.getMusicRadio).not.toHaveBeenCalled();
  });
});

describe("fromPlaylistPanel — the RDAMVM music-radio queue row", () => {
  test("parses id, title, artist and duration", () => {
    const got = fromPlaylistPanel({
      videoId: "abcdefghijk",
      title: { simpleText: "Archangel" },
      longBylineText: { runs: [{ text: "Burial" }] },
      lengthText: { simpleText: "3:59" },
    });
    expect(got).toMatchObject({ videoId: "abcdefghijk", title: "Archangel", artist: "Burial", duration: 239 });
  });

  test("rejects a malformed id, and a row with no title", () => {
    expect(fromPlaylistPanel({ videoId: "short", title: { simpleText: "x" } })).toBeNull();
    expect(fromPlaylistPanel({ videoId: "abcdefghijk" })).toBeNull();
  });

  // The soft length backstop is what keeps hour-long mixes and livestreams off a deck.
  test("rejects an hour-long upload", () => {
    expect(fromPlaylistPanel({ videoId: "abcdefghijk", title: { simpleText: "mix" }, lengthText: { simpleText: "1:02:00" } })).toBeNull();
  });

  // Unlike the watch-next sidebar, a music-radio row needs no MUSIC-badge test: YouTube Music
  // built the sequence, so everything in it is already music.
  test("collectVideos walks playlistPanelVideoRenderer nodes out of a nested payload", () => {
    const payload = {
      contents: { playlist: { playlist: { contents: [{ playlistPanelVideoRenderer: { videoId: "abcdefghijk", title: { simpleText: "One" } } }] } } },
    };
    const out: TrackMeta[] = [];
    collectVideos(payload, (x) => out.push(x));
    expect(out.map((x) => x.videoId)).toEqual(["abcdefghijk"]);
  });
});

// ── the non-song filter ─────────────────────────────────────────────────────────────────────────
// Both the watch-next sidebar and the YouTube Music radio queue leak non-tracks into the auto-mix
// pool. These are the exact titles observed doing it live, plus the real records that must survive.
describe("isNonSong", () => {
  test("rejects the compilations that were actually reaching the pool", () => {
    expect(isNonSong("(fan-voted) top 100 most recognizable songs of all-time", 878)).toBe(true);
    expect(isNonSong("Best of 2023 — Full Album", 2000)).toBe(true);
    expect(isNonSong("Greatest Hits Playlist", 1200)).toBe(true);
  });

  test("rejects videos that aren't primarily music", () => {
    expect(isNonSong("Producer REACTS TO Aphex Twin", 600)).toBe(true);
    expect(isNonSong("Ableton tutorial: sidechain compression", 500)).toBe(true);
    expect(isNonSong("Dune Part Two | Official Trailer", 150)).toBe(true);
  });

  test("rejects clips and stings too short to be a record", () => {
    expect(isNonSong("Some Track", 30)).toBe(true);
  });

  // ★ THE IMPORTANT HALF. A filter that eats real records is worse than no filter — plenty of
  // legitimate tracks carry "live", "remix" or "mix" in the title, and none of those are markers.
  test("keeps real records, including the ones with suspicious words in the title", () => {
    expect(isNonSong("Massive Attack - Teardrop", 330)).toBe(false);
    expect(isNonSong("Four Tet - Two Thousand and Seventeen (Live)", 400)).toBe(false);
    expect(isNonSong("Aphex Twin - Windowlicker (Extended Mix)", 380)).toBe(false);
    expect(isNonSong("Burial - Archangel", 239)).toBe(false);
    expect(isNonSong("Top Gun Anthem", 200)).toBe(false); // "top" without a count is not a chart
  });

  test("an unknown duration is not evidence of anything — keep it", () => {
    expect(isNonSong("Some Track", 0)).toBe(false);
  });
});
