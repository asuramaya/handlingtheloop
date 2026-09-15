import { beforeEach, describe, expect, it } from "vitest";
import { loadTableState, saveTableState, type TrackTableState } from "./trackTableState";

// The store behind "the library remembers where you were". The reason it is worth testing at all
// is the FORWARD-COMPATIBILITY rule: this blob is written by one build and read by the next, and
// the tempting shape — parse, validate the whole object, bail on anything unexpected — throws away
// a person's sort and scroll because a later build added a field. Each field is read on its own.

const full: TrackTableState = { sortKey: "title", sortDir: -1, query: "dub", cacheOnly: true, stemOnly: false, scrollTop: 1200 };

// A real Storage, not a mock of the module under test — the suite runs in node, where there is no
// localStorage at all. Stubbing the PLATFORM keeps the thing being tested unmodified; mocking the
// store's own functions would leave the parsing this file exists to check untested.
const mem = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, String(v)),
    removeItem: (k: string) => void mem.delete(k),
    clear: () => mem.clear(),
    get length() { return mem.size; },
    key: (i: number) => [...mem.keys()][i] ?? null,
  },
});

describe("trackTableState", () => {
  beforeEach(() => localStorage.clear());

  it("round-trips everything the find-controls hold", () => {
    saveTableState("collection", full);
    expect(loadTableState("collection")).toEqual(full);
  });

  it("keys are per list — one list's scroll never restores into another", () => {
    saveTableState("collection", full);
    saveTableState("community", { ...full, scrollTop: 40, query: "" });
    expect(loadTableState("collection").scrollTop).toBe(1200);
    expect(loadTableState("community").scrollTop).toBe(40);
    expect(loadTableState("pl:never-saved")).toEqual({});
  });

  it("★ a blob from an older build keeps every field it DID carry", () => {
    // The exact regression this shape exists to prevent: a partial answer is not a corrupt one.
    localStorage.setItem("htl:tt:collection", JSON.stringify({ sortKey: "artist", scrollTop: 88 }));
    const got = loadTableState("collection");
    expect(got.sortKey).toBe("artist");
    expect(got.scrollTop).toBe(88);
    expect(got.query).toBeUndefined(); // absent, so the caller's default applies — not a wipe
  });

  it("drops fields of the wrong type without discarding the rest", () => {
    localStorage.setItem("htl:tt:collection", JSON.stringify({ sortKey: "title", sortDir: 7, scrollTop: -5, cacheOnly: "yes" }));
    const got = loadTableState("collection");
    expect(got.sortKey).toBe("title");
    expect(got.sortDir).toBeUndefined(); // 7 is not 1 or -1
    expect(got.scrollTop).toBeUndefined(); // negative is not a scroll position
    expect(got.cacheOnly).toBeUndefined(); // a string is not a boolean
  });

  it("survives corrupt JSON rather than throwing into a render", () => {
    localStorage.setItem("htl:tt:collection", "{not json");
    expect(loadTableState("collection")).toEqual({});
  });

  it("no key means no memory and no write — the search table opts out this way", () => {
    saveTableState(undefined, full);
    expect(localStorage.length).toBe(0);
    expect(loadTableState(undefined)).toEqual({});
  });
});
