import { describe, test, expect } from "vitest";
import { dedupeByVideoId } from "./queue";
import type { TrackMeta } from "../library/types";

// Minimal TrackMeta literal — videoId is the only field dedupeByVideoId reads, but
// TrackMeta requires the others, so fill them with neutral values.
const t = (videoId: string, title = videoId): TrackMeta => ({
  videoId,
  title,
  artist: "",
  duration: 0,
  thumbnail: null,
  views: null,
});

describe("dedupeByVideoId", () => {
  test("empty list → empty list", () => {
    expect(dedupeByVideoId([])).toEqual([]);
  });

  test("no duplicates → same items, same order", () => {
    const list = [t("a"), t("b"), t("c")];
    const out = dedupeByVideoId(list);
    expect(out.map((x) => x.videoId)).toEqual(["a", "b", "c"]);
  });

  test("removes duplicate videoIds, KEEPING the first occurrence", () => {
    const first = t("a", "first-a");
    const dupe = t("a", "second-a");
    const out = dedupeByVideoId([first, t("b"), dupe]);
    expect(out.map((x) => x.videoId)).toEqual(["a", "b"]);
    // The kept object is the FIRST occurrence (its title, not the later dupe's).
    expect(out[0]).toBe(first);
    expect(out[0].title).toBe("first-a");
  });

  test("preserves order of distinct ids while collapsing interleaved dupes", () => {
    const list = [t("a"), t("b"), t("a"), t("c"), t("b"), t("c"), t("d")];
    const out = dedupeByVideoId(list);
    expect(out.map((x) => x.videoId)).toEqual(["a", "b", "c", "d"]);
  });

  test("drops entries with a falsy (empty) videoId", () => {
    // The guard `if (!t.videoId || seen.has(...)) continue` skips "" videoIds entirely.
    const list = [t(""), t("a"), t(""), t("b")];
    const out = dedupeByVideoId(list);
    expect(out.map((x) => x.videoId)).toEqual(["a", "b"]);
  });

  test("returns a NEW array (does not mutate the input)", () => {
    const list = [t("a"), t("a")];
    const out = dedupeByVideoId(list);
    expect(out).not.toBe(list);
    expect(list).toHaveLength(2); // input untouched
    expect(out).toHaveLength(1);
  });

  test("all-duplicate list collapses to a single entry", () => {
    const out = dedupeByVideoId([t("x"), t("x"), t("x")]);
    expect(out.map((v) => v.videoId)).toEqual(["x"]);
  });
});
