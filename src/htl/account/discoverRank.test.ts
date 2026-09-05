import { describe, it, expect } from "vitest";
import { rankRooms, filterRooms, reasonFor, FRESH_MS, FRESH_MAX_LISTENERS, type Reason } from "./discoverRank";
import type { LiveRoom } from "./index";

const room = (o: Partial<LiveRoom> & { handle: string }): LiveRoom => ({
  displayName: null, avatar: null, title: null, genre: null,
  listeners: 0, npTitle: null, npArtist: null, startedAt: null, ...o,
});
const NOW = 1_000_000_000;

describe("reasonFor", () => {
  it("reads the SERVER's relationship, not a client guess", () => {
    expect(reasonFor(room({ handle: "a", rel: 2 }), NOW)).toBe("friend");
    expect(reasonFor(room({ handle: "a", rel: 1 }), NOW)).toBe("following");
    expect(reasonFor(room({ handle: "a", rel: 0 }), NOW)).toBe("popular");
    expect(reasonFor(room({ handle: "a" }), NOW)).toBe("popular"); // signed out: no rel at all
  });

  it("calls a brand-new stranger's room FRESH — the anti-ratchet slot", () => {
    expect(reasonFor(room({ handle: "a", startedAt: NOW - 60_000 }), NOW)).toBe("fresh");
    expect(reasonFor(room({ handle: "a", startedAt: NOW - FRESH_MS - 1 }), NOW)).toBe("popular");
  });

  it("relationship OUTRANKS freshness — a friend is a friend however long they have been on", () => {
    expect(reasonFor(room({ handle: "a", rel: 2, startedAt: NOW - 60_000 }), NOW)).toBe("friend");
  });

  // ★ REGRESSION, found by rendering a 141-room fixture: recency alone let the BIGGEST room in
  // the directory take the newcomer slot 30 seconds after going on air — the anti-ratchet
  // promoting the ratchet. A newcomer is new AND small.
  it("a BIG room that just went on air is popular, not fresh", () => {
    expect(reasonFor(room({ handle: "a", startedAt: NOW - 30_000, listeners: 900 }), NOW)).toBe("popular");
    expect(reasonFor(room({ handle: "a", startedAt: NOW - 30_000, listeners: FRESH_MAX_LISTENERS + 1 }), NOW)).toBe("popular");
    expect(reasonFor(room({ handle: "a", startedAt: NOW - 30_000, listeners: FRESH_MAX_LISTENERS }), NOW)).toBe("fresh");
  });
});

describe("rankRooms", () => {
  const order = (rooms: LiveRoom[]) => rankRooms(rooms, NOW).map((r) => r.room.handle);

  it("puts relationship before popularity — this is the whole point", () => {
    // The stranger is 100x bigger. It still loses to a friend and to someone you follow.
    expect(
      order([
        room({ handle: "huge", listeners: 5000, rel: 0 }),
        room({ handle: "pal", listeners: 2, rel: 2 }),
        room({ handle: "known", listeners: 5, rel: 1 }),
      ]),
    ).toEqual(["pal", "known", "huge"]);
  });

  it("orders by listeners WITHIN a reason", () => {
    expect(
      order([
        room({ handle: "small", listeners: 1, rel: 2 }),
        room({ handle: "big", listeners: 99, rel: 2 }),
      ]),
    ).toEqual(["big", "small"]);
  });

  it("is STABLE on a full tie, so a 30 s poll cannot reshuffle the list under your finger", () => {
    const rooms = [room({ handle: "zeta" }), room({ handle: "alpha" }), room({ handle: "mid" })];
    const a = order(rooms);
    const b = order([...rooms].reverse()); // same set, arrives in a different order
    expect(a).toEqual(b);
    expect(a).toEqual(["alpha", "mid", "zeta"]);
  });

  it("gives a fresh newcomer a place above the established crowd", () => {
    const out = rankRooms(
      [room({ handle: "old", listeners: 900 }), room({ handle: "new", listeners: 0, startedAt: NOW - 1000 })],
      NOW,
    );
    expect(out.map((r) => r.room.handle)).toEqual(["new", "old"]);
    expect(out.map((r) => r.reason)).toEqual<Reason[]>(["fresh", "popular"]);
  });
});

describe("filterRooms", () => {
  const ranked = rankRooms(
    [
      room({ handle: "dj_nova", displayName: "Nova", genre: "techno", npTitle: "Windowlicker" }),
      room({ handle: "beatsmith", title: "Sunday ambient", npArtist: "Aphex Twin" }),
    ],
    NOW,
  );
  const hit = (q: string) => filterRooms(ranked, q).map((r) => r.room.handle);

  it("matches every field the ROW ACTUALLY SHOWS", () => {
    expect(hit("nova")).toEqual(["dj_nova"]);       // handle + display name
    expect(hit("techno")).toEqual(["dj_nova"]);     // genre
    expect(hit("ambient")).toEqual(["beatsmith"]);  // title
    expect(hit("aphex")).toEqual(["beatsmith"]);    // now-playing artist
    expect(hit("windowlicker")).toEqual(["dj_nova"]); // now-playing title
  });

  it("is case- and whitespace-forgiving, and an empty query is not a filter", () => {
    expect(hit("  NOVA ")).toEqual(["dj_nova"]);
    expect(hit("   ")).toHaveLength(2);
    expect(hit("")).toHaveLength(2);
  });

  it("preserves rank order in the filtered subset", () => {
    const r = rankRooms(
      [room({ handle: "b_big", listeners: 90, genre: "house" }), room({ handle: "a_pal", listeners: 1, rel: 2, genre: "house" })],
      NOW,
    );
    expect(filterRooms(r, "house").map((x) => x.room.handle)).toEqual(["a_pal", "b_big"]);
  });
});
