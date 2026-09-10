import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchLiveRooms, fetchDiscoverSets } from "./index";

// THE CLIENT MUST NOT INVENT COMPLETENESS, and there are two ways it could.
//
// Thread 0c98985c: both directory endpoints cap server-side with no signal, so a list that stops
// at the cap reads as the whole set. The server now sends `truncated`; these pin what happens at
// the two edges where the client has to decide for itself.
//
//   • AN OLDER SERVER does not send the field. Defaulting it to TRUE would put a permanent "more
//     exist" note under every list on a deployment that is merely behind; defaulting to FALSE is
//     the honest reading — no claim was made, so make none.
//   • A FAILED REQUEST returns nothing. It must not come back as "truncated", which would tell the
//     user rooms exist that we never actually looked for.

afterEach(() => vi.unstubAllGlobals());

function stubJson(body: unknown, ok = true) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok, json: async () => body }));
}

describe("fetchLiveRooms returns a page that never overclaims", () => {
  it("carries the server's truncation flag through", async () => {
    stubJson({ rooms: [{ handle: "a" }, { handle: "b" }], truncated: true, limit: 2 });
    const p = await fetchLiveRooms();
    expect(p.items).toHaveLength(2);
    expect(p.truncated).toBe(true);
    expect(p.limit).toBe(2);
  });

  it("treats a server that omits the field as NOT truncated, and infers the limit", async () => {
    stubJson({ rooms: [{ handle: "a" }] });
    const p = await fetchLiveRooms();
    expect(p.truncated).toBe(false); // never a standing false alarm on an older deployment
    expect(p.limit).toBe(1);
  });

  it("a failed request is an empty page, not a truncated one", async () => {
    stubJson({}, false);
    const p = await fetchLiveRooms();
    expect(p.items).toEqual([]);
    expect(p.truncated).toBe(false);
  });

  it("does not confuse an explicit false with a missing field", async () => {
    stubJson({ rooms: [{ handle: "a" }], truncated: false, limit: 100 });
    const p = await fetchLiveRooms();
    expect(p.truncated).toBe(false);
    expect(p.limit).toBe(100); // the SERVER's cap, not the row count — a client saying "first 100"
  });
});

describe("fetchDiscoverSets follows the same contract", () => {
  it("carries truncation and survives an older server", async () => {
    stubJson({ sets: [{ id: "s1" }], truncated: true, limit: 60 });
    const t = await fetchDiscoverSets();
    expect(t.items).toHaveLength(1);
    expect(t.truncated).toBe(true);
    expect(t.limit).toBe(60);
    stubJson({ sets: [{ id: "s1" }] });
    const old = await fetchDiscoverSets();
    expect(old.truncated).toBe(false);
  });

  it("a failed request is an empty page", async () => {
    stubJson({}, false);
    const p = await fetchDiscoverSets();
    expect(p.items).toEqual([]);
    expect(p.truncated).toBe(false);
  });
});
