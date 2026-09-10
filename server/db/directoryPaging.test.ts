import { describe, expect, it } from "vitest";
import { liveRooms, liveFollowedRooms } from "./rooms";

/** The cursor is base64url, so a test that hand-writes one has to speak the same encoding. */
const b64 = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
import { discoverSets } from "./sets";

// THE DIRECTORY USED TO LIE ABOUT BEING COMPLETE (thread 0c98985c).
//
// /api/rooms/live was LIMIT 100 with no cursor and no signal; discoverSets LIMIT 60, same shape.
// Past the cap they silently truncate — the worst kind of ceiling, because it looks like a whole
// answer. This file pins the two properties that fix stops being a fix without.
//
// ★ AND A SECOND DEFECT FOUND WHILE FIXING THE FIRST: neither ORDER BY resolved over a set proven
// unique. `published_at` is not unique (a batch publish makes ties likely), and rooms ordered by
// (listeners, started_at) — also not unique. With a non-total ORDER BY, WHICH of two tied rows
// survives the LIMIT is arbitrary and can differ between two identical calls: a coin flip dressed
// as a deterministic read. Both now end in a primary key, so the boundary is determinate.
//
// No D1 here and none needed. These are stub statements that record the SQL and hand back a set
// number of rows; the questions asked are "what did it ask the database for" and "what did it do
// with the answer" — both of which are the actual defect surface.

interface Asked { sql: string; binds: unknown[] }

function fakeDb(rowCount: number, asked: Asked[] = []) {
  return {
    asked,
    prepare(sql: string) {
      const rec: Asked = { sql, binds: [] };
      asked.push(rec);
      const stmt = {
        bind(...b: unknown[]) {
          rec.binds = b;
          return stmt;
        },
        // Rows must carry the columns the query actually SELECTs — startedAt and hostId are what
        // the cursor is built from, and a fake that omits them silently produces "no next page"
        // rather than a failure. Descending startedAt, matching the ordering under test.
        all: async () => ({
          results: Array.from({ length: rowCount }, (_, i) => ({
            handle: `h${i}`,
            startedAt: 1_700_000_000 - i,
            hostId: `user-${i}`,
          })),
        }),
      };
      return stmt;
    },
  } as unknown as Parameters<typeof liveRooms>[0] & { asked: Asked[] };
}

/** The ORDER BY's final term — the one that has to be unique for the boundary to be determinate. */
function lastOrderTerm(sql: string): string {
  const m = /ORDER BY([\s\S]*?)LIMIT/i.exec(sql);
  if (!m) throw new Error("no ORDER BY … LIMIT in the statement");
  const terms = m[1].split(",").map((t) => t.trim());
  return terms[terms.length - 1];
}

describe("the live-rooms directory reports that it is a slice", () => {
  it("asks for one MORE row than it returns, so truncation needs no COUNT(*)", async () => {
    const asked: Asked[] = [];
    const db = fakeDb(0, asked);
    await liveRooms(db, { limit: 100, viewerId: null });
    // The cap travels as the LAST bind on both branches; the probe is limit+1.
    expect(asked[0].binds[asked[0].binds.length - 1]).toBe(101);
  });

  it("returns exactly `limit` rows and flags truncation when the probe row comes back", async () => {
    const page = await liveRooms(fakeDb(101), { limit: 100, viewerId: null });
    expect(page.rooms).toHaveLength(100); // the probe row is TRIMMED, never served
    expect(page.truncated).toBe(true);
    expect(page.limit).toBe(100);
  });

  it("does not cry truncation when the set fits exactly", async () => {
    // The off-by-one that would make this feature a permanent false alarm.
    const page = await liveRooms(fakeDb(100), { limit: 100, viewerId: null });
    expect(page.rooms).toHaveLength(100);
    expect(page.truncated).toBe(false);
  });

  it("reports honestly on a short set", async () => {
    const page = await liveRooms(fakeDb(3), { limit: 100, viewerId: null });
    expect(page.rooms).toHaveLength(3);
    expect(page.truncated).toBe(false);
  });

  it("orders over a TOTAL key on BOTH branches — signed out and signed in", async () => {
    // Two branches, two SQL statements, and the signed-in one sorts by `rel` first. A tiebreak
    // added to only one of them is the same bug with a narrower trigger, so both are asserted.
    const out: Asked[] = [];
    await liveRooms(fakeDb(0, out), { limit: 10, viewerId: null });
    const inn: Asked[] = [];
    await liveRooms(fakeDb(0, inn), { limit: 10, viewerId: "viewer-1" });
    for (const a of [out[0], inn[0]]) {
      // host_id is the rooms table's primary key (announceRoom's ON CONFLICT target), so it is
      // the column that makes this ordering total.
      expect(lastOrderTerm(a.sql)).toMatch(/host_id/);
    }
    expect(inn[0].sql).toMatch(/ORDER BY rel DESC/); // the relationship-first ordering is intact
  });
});

describe("the discover-sets directory reports that it is a slice", () => {
  it("probes with limit+1 and trims", async () => {
    const asked: Asked[] = [];
    await discoverSets(fakeDb(0, asked), 60);
    expect(asked[0].binds[0]).toBe(61);
    const page = await discoverSets(fakeDb(61), 60);
    expect(page.sets).toHaveLength(60);
    expect(page.truncated).toBe(true);
    const exact = await discoverSets(fakeDb(60), 60);
    expect(exact.truncated).toBe(false);
  });

  it("orders over a TOTAL key — published_at is not unique, id is", async () => {
    const asked: Asked[] = [];
    await discoverSets(fakeDb(0, asked), 60);
    expect(lastOrderTerm(asked[0].sql)).toMatch(/\bs\.id\b/);
  });
});

describe("two orderings, and only one of them can page", () => {
  // Operator ruling 39dc683e: "let the user pick between busy vs recent default to busy." That
  // dissolved a trade-off rather than picking a side of it — each mode now only has to be coherent
  // on its own terms, and these tests are what hold that line.

  it("BUSY never offers a cursor, however much is behind the cap", async () => {
    // ★ THE LOAD-BEARING ONE. `listeners` is rewritten by announceRoom on every heartbeat, so a
    // keyset cursor over it would serve a room twice or skip it entirely as its count moved —
    // silently, with no error anywhere. Refusing to mint the cursor is the fix; this asserts the
    // refusal survives even in the state where a cursor would be most tempting (more rows exist).
    const page = await liveRooms(fakeDb(101), { limit: 100, sort: "busy" });
    expect(page.truncated).toBe(true);
    expect(page.nextCursor).toBeNull();
  });

  it("BUSY is the default, and an unknown sort is not an error", async () => {
    const dflt = await liveRooms(fakeDb(101), { limit: 100 });
    expect(dflt.nextCursor).toBeNull();
    const junk = await liveRooms(fakeDb(101), { limit: 100, sort: "sideways" as unknown as "busy" });
    expect(junk.nextCursor).toBeNull(); // a browse surface shows rooms on a typo, it does not 400
  });

  it("RECENT orders by the immutable pair and hands back a cursor", async () => {
    const asked: Asked[] = [];
    const page = await liveRooms(fakeDb(3, asked), { limit: 2, sort: "recent" });
    // started_at is COALESCE-preserved for the life of a broadcast; host_id is the PK. Immutable
    // AND total — the two properties a keyset cursor actually needs.
    expect(asked[0].sql).toMatch(/ORDER BY r\.started_at DESC, r\.host_id DESC/);
    expect(page.rooms).toHaveLength(2);
    expect(page.truncated).toBe(true);
    expect(page.nextCursor).not.toBeNull();
  });

  it("RECENT withholds the cursor on the LAST page", async () => {
    // A cursor on a complete page invites one more round trip that returns nothing, forever.
    const page = await liveRooms(fakeDb(2), { limit: 2, sort: "recent" });
    expect(page.truncated).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  it("the cursor asks for rows strictly AFTER it, in the same total order", async () => {
    const asked: Asked[] = [];
    await liveRooms(fakeDb(0, asked), { limit: 10, sort: "recent", cursor: b64("1700000000:user-9") });
    // Both limbs are required. `started_at < ?` alone drops every row tied on the timestamp;
    // the tie limb carries them, ordered by the key that makes the ordering total.
    expect(asked[0].sql).toMatch(/r\.started_at < \? OR \(r\.started_at = \? AND r\.host_id < \?\)/);
    expect(asked[0].binds).toContain(1700000000);
    expect(asked[0].binds).toContain("user-9");
  });

  it("a host id containing a colon survives the round trip", async () => {
    // The cursor is `<startedAt>:<hostId>` split on the FIRST colon. A host id with its own colon
    // would otherwise decode to a truncated id that matches nothing — an empty page 2 and no error.
    const asked: Asked[] = [];
    await liveRooms(fakeDb(0, asked), { limit: 10, sort: "recent", cursor: b64("1700000000:a:b:c") });
    expect(asked[0].binds).toContain("a:b:c");
  });

  it("a malformed cursor reads as the FIRST page, never as a bound NaN", async () => {
    // Binding NaN matches nothing and looks exactly like "the directory is empty".
    for (const bad of ["", "nonsense", b64(":user-1"), b64("abc:user-1"), b64("1700000000:"), "!!!not-base64!!!"]) {
      const asked: Asked[] = [];
      await liveRooms(fakeDb(0, asked), { limit: 10, sort: "recent", cursor: bad });
      expect(asked[0].sql).not.toMatch(/r\.started_at < \?/);
      expect(asked[0].binds.some((b) => typeof b === "number" && Number.isNaN(b))).toBe(false);
    }
  });

  it("a cursor passed to BUSY is ignored, not half-applied", async () => {
    const asked: Asked[] = [];
    await liveRooms(fakeDb(0, asked), { limit: 10, sort: "busy", cursor: b64("1700000000:user-9") });
    expect(asked[0].sql).not.toMatch(/r\.started_at < \?/);
  });

  it("rel leads in BUSY and never in RECENT — and recent still RETURNS rel", async () => {
    // Ranking is what busy is for. Putting a viewer-relative, mutable value at the head of the
    // recent cursor key would contradict both the name and the reason the key works.
    const busy: Asked[] = [];
    await liveRooms(fakeDb(0, busy), { limit: 10, viewerId: "v1", sort: "busy" });
    expect(busy[0].sql).toMatch(/ORDER BY rel DESC/);
    const rec: Asked[] = [];
    await liveRooms(fakeDb(0, rec), { limit: 10, viewerId: "v1", sort: "recent" });
    expect(rec[0].sql).not.toMatch(/ORDER BY rel DESC/);
    expect(rec[0].sql).toMatch(/AS rel/); // still selected, so the UI can badge a followed host
  });

  it("never leaks host_id into a room row", async () => {
    // It is an internal id. It rides inside the opaque cursor and nowhere else.
    const page = await liveRooms(fakeDb(2), { limit: 5, sort: "recent" });
    for (const room of page.rooms) expect(room).not.toHaveProperty("hostId");
  });
});

describe("the bell's followed-rooms read is NOT the directory with a filter", () => {
  // Thread 0c98985c called this "pure duplication" of /api/rooms/live and proposed collapsing the
  // two to save a per-user D1 read. It is not duplication, and the difference is a safety one.

  it("gates on blocks in BOTH directions — the reason it cannot be sourced from the directory", async () => {
    // liveRooms has no blocks predicate at all (the directory is public). Sourcing the bell from
    // it would deliver a blocked host's live room into the blocker's notifications. The gate is
    // defence-in-depth — a block already deletes the follow edge — and defence-in-depth is
    // precisely what gets deleted for looking redundant.
    const asked: Asked[] = [];
    await liveFollowedRooms(fakeDb(0, asked), "viewer-1");
    expect(asked[0].sql).toMatch(/NOT EXISTS/);
    expect(asked[0].sql).toMatch(/b\.blocker_id = f\.follower_id AND b\.blocked_id = f\.followee_id/);
    expect(asked[0].sql).toMatch(/b\.blocker_id = f\.followee_id AND b\.blocked_id = f\.follower_id/);

    // The directory gates too, as of the operator's 2026-09-10 call — it was the ONLY
    // viewer-relative read in the codebase that did not, which made it a gap rather than a policy.
    const dir: Asked[] = [];
    await liveRooms(fakeDb(0, dir), { limit: 10, viewerId: "viewer-1" });
    expect(dir[0].sql).toMatch(/blocker_id/);
  });

  it("orders over a TOTAL key, like the directory does", async () => {
    // started_at alone is not unique; which of two rooms started in the same millisecond survived
    // LIMIT 50 was arbitrary and could differ between two identical calls.
    const asked: Asked[] = [];
    await liveFollowedRooms(fakeDb(0, asked), "viewer-1");
    expect(lastOrderTerm(asked[0].sql)).toMatch(/host_id/);
  });
});

describe("the directory applies blocks, in both directions and in the right bind slots", () => {
  it("filters a blocked host BOTH ways for a signed-in viewer", async () => {
    const asked: Asked[] = [];
    await liveRooms(fakeDb(0, asked), { limit: 10, viewerId: "viewer-1" });
    expect(asked[0].sql).toMatch(/bl\.blocker_id = \? AND bl\.blocked_id = r\.host_id/);
    expect(asked[0].sql).toMatch(/bl\.blocker_id = r\.host_id AND bl\.blocked_id = \?/);
  });

  it("adds NO block predicate for a signed-out viewer", async () => {
    // Nobody to filter against, and a NOT EXISTS with nothing to bind would silently misalign
    // every parameter after it.
    const asked: Asked[] = [];
    await liveRooms(fakeDb(0, asked), { limit: 10, viewerId: null });
    expect(asked[0].sql).not.toMatch(/blocker_id/);
  });

  it("★ BINDS LINE UP WITH THE ? MARKS — the failure this whole query shape invites", async () => {
    // Positional binds across four optional fragments (rel join, block gate, keyset, limit). A
    // fragment added without its binds, or in the wrong order, does not throw: it shifts every
    // later parameter by one and the query quietly answers a different question. Count them.
    const both: Asked[] = [];
    await liveRooms(fakeDb(0, both), { limit: 10, viewerId: "v1", sort: "recent", cursor: b64("123:h1") });
    const marks = (both[0].sql.match(/\?/g) ?? []).length;
    expect(both[0].binds).toHaveLength(marks);
    // And the order: rel join (v1, v1), cutoff, block gate (v1, v1), keyset (123, 123, h1), limit.
    expect(both[0].binds[0]).toBe("v1");
    expect(both[0].binds[1]).toBe("v1");
    expect(both[0].binds[3]).toBe("v1");
    expect(both[0].binds[4]).toBe("v1");
    expect(both[0].binds[5]).toBe(123);
    expect(both[0].binds[7]).toBe("h1");
    expect(both[0].binds[both[0].binds.length - 1]).toBe(11); // limit + 1 probe

    // Same check with each fragment absent, since that is where a shift would hide.
    for (const opts of [
      { limit: 10, viewerId: null },
      { limit: 10, viewerId: "v1" },
      { limit: 10, viewerId: null, sort: "recent" as const, cursor: b64("5:h") },
    ]) {
      const a: Asked[] = [];
      await liveRooms(fakeDb(0, a), opts);
      expect(a[0].binds).toHaveLength((a[0].sql.match(/\?/g) ?? []).length);
    }
  });
});

describe("the cursor is opaque in the sense it claims to be", () => {
  it("does NOT hand the internal host id back in plain sight", async () => {
    // The defect this fixes: room objects had hostId stripped because "an internal id does not
    // belong in a public payload", and then the cursor emitted it verbatim. The payload was
    // scrubbed and the cursor handed the same value straight back.
    const page = await liveRooms(fakeDb(3), { limit: 2, sort: "recent" });
    expect(page.nextCursor).not.toBeNull();
    expect(page.nextCursor).not.toContain("user-");
    expect(page.nextCursor).not.toContain(":");
  });

  it("round-trips through the query it was built from", async () => {
    // Encoding is only worth anything if it decodes back to the same keyset binds — otherwise
    // page 2 silently returns page 1 forever, which reads as "the list stopped growing".
    const first = await liveRooms(fakeDb(3), { limit: 2, sort: "recent" });
    const asked: Asked[] = [];
    await liveRooms(fakeDb(0, asked), { limit: 2, sort: "recent", cursor: first.nextCursor });
    expect(asked[0].binds).toContain(1_699_999_999); // the 2nd fake row (the fake counts DOWN)
    expect(asked[0].binds).toContain("user-1");
  });

  it("a cursor that is not ours reads as the first page, never as an error", async () => {
    // Includes the case that only exists now: a string that is not valid base64 at all.
    const asked: Asked[] = [];
    await liveRooms(fakeDb(0, asked), { limit: 5, sort: "recent", cursor: "????" });
    expect(asked[0].sql).not.toMatch(/r\.started_at < \?/);
  });
});
