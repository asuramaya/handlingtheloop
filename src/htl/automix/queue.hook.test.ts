import { describe, test, expect, vi, beforeEach } from "vitest";
import type { TrackMeta } from "../library/types";
import type { RadioContext } from "./types";

// THE QUEUE HOOK, DRIVEN WITHOUT A DOM. The repo has no React test renderer, and useMixQueue only
// needs useState/useRef/useCallback — so "react" is replaced with a tiny slot-based hook store, and
// a "render" is just calling the hook again with the slot cursor reset. Every queue write updates
// its ref synchronously, so reads between renders (peekNext) see the latest list, as in the app.

const hooks = vi.hoisted(() => ({ slots: [] as unknown[], i: 0 }));
vi.mock("react", () => {
  const slot = <T,>(init: () => T): T => {
    const k = hooks.i++;
    if (!(k in hooks.slots)) hooks.slots[k] = init();
    return hooks.slots[k] as T;
  };
  return {
    useState: <T,>(init: T | (() => T)) => {
      const s = slot(() => ({ v: typeof init === "function" ? (init as () => T)() : init }));
      return [s.v, (n: T | ((c: T) => T)) => (s.v = typeof n === "function" ? (n as (c: T) => T)(s.v) : n)] as const;
    },
    useRef: <T,>(init: T) => slot(() => ({ current: init })),
    useCallback: <F,>(fn: F) => slot(() => fn),
  };
});

const recs = vi.hoisted(() => ({ list: [] as TrackMeta[] }));
vi.mock("../media/recommend", () => ({ fetchRecommendations: async () => recs.list }));
vi.mock("../media/api", () => ({ fetchFeaturesByIsrcRows: async () => null }));
vi.mock("../media/analysisStatus", () => ({ lookupAnalysis: async () => ({}), analysisState: () => null }));

import { useMixQueue, keepNonRadio } from "./queue";

const t = (videoId: string, over: Partial<TrackMeta> = {}): TrackMeta => ({
  videoId,
  title: `${videoId} title`,
  artist: `${videoId} artist`,
  duration: 200,
  thumbnail: null,
  views: null,
  ...over,
});
const ctx = (current: TrackMeta): RadioContext => ({ anchor: current, current, anchorAge: 0, played: 0, arc: "ride" });

function render() {
  hooks.i = 0;
  return useMixQueue();
}

beforeEach(() => {
  hooks.slots = [];
  recs.list = [t("rad00000001"), t("rad00000002"), t("rad00000003"), t("rad00000004"), t("rad00000005")];
});

describe("queue provenance", () => {
  test("radio draws are tagged radio; add / play-next are tagged user", async () => {
    let q = render();
    await q.ensureNext(ctx(t("seed0000001")));
    q = render();
    expect(q.upcoming.length).toBe(5); // all five the radio returned (the list runs ten deep now)
    expect(q.upcoming.every((x) => x.source === "radio")).toBe(true);
    q.enqueue(t("mine0000001"));
    q.enqueueNext(t("mine0000002"));
    q = render();
    expect(q.upcoming[0]).toMatchObject({ videoId: "mine0000002", source: "user" });
    expect(q.upcoming.at(-1)).toMatchObject({ videoId: "mine0000001", source: "user" });
  });

  test("reseedRadio keeps every user row and drops only radio rows", async () => {
    let q = render();
    await q.ensureNext(ctx(t("seed0000001")));
    q = render();
    q.enqueue(t("mine0000001"));
    q.enqueue(t("mine0000002"));
    q.reseedRadio();
    q = render();
    expect(q.upcoming.map((x) => x.videoId)).toEqual(["mine0000001", "mine0000002"]);
  });

  test("changing the arc keeps user rows", async () => {
    let q = render();
    await q.ensureNext(ctx(t("seed0000001")));
    q = render();
    q.enqueue(t("mine0000001"));
    q.setArc("build");
    q = render();
    expect(q.upcoming.map((x) => x.videoId)).toEqual(["mine0000001"]);
  });

  test("'Radio' from the source menu (an empty load) keeps user rows", () => {
    let q = render();
    q.loadTracks([t("pl000000001"), t("pl000000002")], { mode: "playlist" });
    q = render();
    expect(q.upcoming.every((x) => x.source === "playlist")).toBe(true);
    q.enqueue(t("mine0000001"));
    q.loadTracks([], { mode: "radio" });
    q = render();
    expect(q.mode).toBe("radio");
    expect(q.upcoming.map((x) => x.videoId)).toEqual(["mine0000001"]);
  });

  test("keepNonRadio treats an untagged row (older peer) as the user's", () => {
    expect(keepNonRadio([{ ...t("a"), source: "radio" }, t("b"), { ...t("c"), source: "playlist" }]).map((x) => x.videoId)).toEqual(["b", "c"]);
  });

  test("the track that goes live leaves the queue (no mixing a song into itself)", () => {
    let q = render();
    q.enqueue(t("sm000000001", { title: "S&M", artist: "Rihanna" }));
    q.enqueue(t("mine0000002"));
    q.setCurrent(t("sm000000001", { title: "S&M", artist: "Rihanna" }));
    expect(q.peekNext()?.videoId).toBe("mine0000002");
    // another upload of the same recording counts too
    q = render();
    q.enqueueNext(t("sm000000009", { title: "Rihanna - S&M (Official Music Video)", artist: "RihannaVEVO" }));
    q = render();
    expect(q.upcoming.map((x) => x.videoId)).toEqual(["mine0000002"]);
  });

  test("remove is visible to peekNext before any re-render", () => {
    const q = render();
    q.enqueue(t("mine0000001"));
    q.enqueue(t("mine0000002"));
    q.remove("mine0000001");
    expect(q.peekNext()?.videoId).toBe("mine0000002");
  });
});

describe("candidate length filter", () => {
  test("a 20-minute upload and a 45 s clip are never drawn", async () => {
    recs.list = [t("long0000001", { duration: 1199 }), t("clip0000001", { duration: 45 }), t("ok000000001"), t("ok000000002")];
    let q = render();
    await q.ensureNext(ctx(t("seed0000001")));
    q = render();
    expect(q.upcoming.map((x) => x.videoId)).toEqual(["ok000000001", "ok000000002"]);
  });
});

describe("playlist end", () => {
  test("a playlist that runs out falls back to radio and says so", async () => {
    let q = render();
    q.loadTracks([t("pl000000001")], { mode: "playlist" });
    q = render();
    const last = q.advance();
    expect(last?.videoId).toBe("pl000000001");
    const next = await q.ensureNext(ctx(last!));
    q = render();
    expect(q.playlistEnded).toBe(true);
    expect(next?.source).toBe("radio");
    expect(q.upcoming.length).toBeGreaterThan(0);
    // Loading a playlist again clears the notice.
    q.loadTracks([t("pl000000002")], { mode: "playlist" });
    q = render();
    expect(q.playlistEnded).toBe(false);
  });

  test("a playlist with tracks left is NOT topped up", async () => {
    let q = render();
    q.loadTracks([t("pl000000001"), t("pl000000002")], { mode: "playlist" });
    q = render();
    const next = await q.ensureNext(ctx(t("seed0000001")));
    q = render();
    expect(next?.videoId).toBe("pl000000001");
    expect(q.upcoming.length).toBe(2);
    expect(q.playlistEnded).toBe(false);
  });
});

describe("a change of direction re-centres the WHOLE suggestion engine", () => {
  const many = (p: string, n: number) => Array.from({ length: n }, (_, i) => t(`${p}${String(i).padStart(11 - p.length, "0")}`));

  // Operator, 2026-11-05: "under your spell to genesis but it still wants to suggest the game and 50 cent".
  test("after a reseed, the old seed's candidates do not come back", async () => {
    recs.list = many("hh", 30);
    let q = render();
    await q.ensureNext(ctx(t("spell000001")));
    q = render();
    expect(q.upcoming.every((x) => x.videoId.startsWith("hh"))).toBe(true);
    q.reseedRadio();
    recs.list = many("sy", 30);
    q = render();
    await q.ensureNext(ctx(t("genesis0001")));
    q = render();
    expect(q.upcoming.length).toBeGreaterThan(0);
    expect(q.upcoming.filter((x) => x.videoId.startsWith("hh"))).toEqual([]);
  });

  test("…but a fill that brings nothing back keeps the old pool rather than an empty list", async () => {
    recs.list = many("hh", 30);
    let q = render();
    await q.ensureNext(ctx(t("spell000001")));
    q = render();
    q.reseedRadio();
    recs.list = [];
    q = render();
    await q.ensureNext(ctx(t("genesis0001")));
    q = render();
    expect(q.upcoming.length).toBeGreaterThan(0);
  });

  test("replacing the next song (play next) clears the old suggestions and refills from the pick", async () => {
    recs.list = many("hh", 30);
    let q = render();
    await q.ensureNext(ctx(t("spell000001")));
    q = render();
    q.enqueue(t("kept0000001")); // a row the user added stays
    q = render();
    q.enqueueNext(t("genesis0001"));
    q = render();
    expect(q.upcoming.map((x) => x.videoId)).toEqual(["genesis0001", "kept0000001"]);
    recs.list = many("sy", 30);
    await q.ensureNext(ctx(t("spell000001")));
    q = render();
    expect(q.upcoming.filter((x) => x.videoId.startsWith("hh"))).toEqual([]);
    expect(q.upcoming.some((x) => x.videoId.startsWith("sy"))).toBe(true);
  });

  // Operator, 2026-11-05: "flipping back and forth the suggestions takes a long time to load".
  test("Suggestions → Playlist → Suggestions puts the same suggestions back at once, without a fetch", async () => {
    let q = render();
    q.setCurrent(t("playing0001"));
    q = render();
    await q.ensureNext(ctx(t("playing0001")));
    q = render();
    const before = q.upcoming.map((x) => x.videoId);
    expect(before.length).toBeGreaterThan(0);
    q.loadTracks([t("pl000000001"), t("pl000000002")], { mode: "playlist" });
    q = render();
    expect(q.upcoming.map((x) => x.videoId)).toEqual(["pl000000001", "pl000000002"]);
    expect(q.current?.videoId).toBe("playing0001"); // the source changed, not what is playing
    q.loadTracks([], { mode: "radio" });
    q = render();
    expect(q.upcoming.map((x) => x.videoId)).toEqual(before); // back immediately, before any ensureNext
  });

  test("taking a SUGGESTION keeps the list; a track you queued yourself is a new direction", async () => {
    let q = render();
    await q.ensureNext(ctx(t("seed0000001")));
    q = render();
    expect(q.setCurrent(q.upcoming[0])).toBe(true);
    q = render();
    q.enqueue(t("mine0000001"));
    q = render();
    expect(q.setCurrent(t("mine0000001"))).toBe(false);
  });
});
