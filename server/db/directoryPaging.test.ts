import { describe, expect, it } from "vitest";
import { liveRooms } from "./rooms";
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
        all: async () => ({ results: Array.from({ length: rowCount }, (_, i) => ({ i })) }),
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
    await liveRooms(db, 100, 90_000, null);
    // The cap travels as the LAST bind on both branches; the probe is limit+1.
    expect(asked[0].binds[asked[0].binds.length - 1]).toBe(101);
  });

  it("returns exactly `limit` rows and flags truncation when the probe row comes back", async () => {
    const page = await liveRooms(fakeDb(101), 100, 90_000, null);
    expect(page.rooms).toHaveLength(100); // the probe row is TRIMMED, never served
    expect(page.truncated).toBe(true);
    expect(page.limit).toBe(100);
  });

  it("does not cry truncation when the set fits exactly", async () => {
    // The off-by-one that would make this feature a permanent false alarm.
    const page = await liveRooms(fakeDb(100), 100, 90_000, null);
    expect(page.rooms).toHaveLength(100);
    expect(page.truncated).toBe(false);
  });

  it("reports honestly on a short set", async () => {
    const page = await liveRooms(fakeDb(3), 100, 90_000, null);
    expect(page.rooms).toHaveLength(3);
    expect(page.truncated).toBe(false);
  });

  it("orders over a TOTAL key on BOTH branches — signed out and signed in", async () => {
    // Two branches, two SQL statements, and the signed-in one sorts by `rel` first. A tiebreak
    // added to only one of them is the same bug with a narrower trigger, so both are asserted.
    const out: Asked[] = [];
    await liveRooms(fakeDb(0, out), 10, 90_000, null);
    const inn: Asked[] = [];
    await liveRooms(fakeDb(0, inn), 10, 90_000, "viewer-1");
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
