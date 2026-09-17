import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";

// The pool keeps module state, so every test gets a fresh module over a fresh mock.
const rows = vi.fn();
vi.mock("./api", () => ({ fetchAnalysisRows: (ids: string[]) => rows(ids) }));

const A = "aaaaaaaaaaa";
const B = "bbbbbbbbbbb";
const C = "ccccccccccc";
const hit = { bpm: 120, key: "8A", energy: 0.5 };

async function pool() {
  vi.resetModules();
  return import("./analysisStatus");
}

beforeEach(() => {
  rows.mockReset();
  vi.useFakeTimers({ toFake: ["Date", "setTimeout"] });
  vi.setSystemTime(1_000_000);
});
afterEach(() => vi.useRealTimers());

describe("lookupAnalysis", () => {
  test("a hit is answered from the pool the second time — no request", async () => {
    const p = await pool();
    rows.mockResolvedValue({ [A]: hit });
    expect(await p.lookupAnalysis([A])).toEqual({ [A]: hit });
    expect(await p.lookupAnalysis([A])).toEqual({ [A]: hit });
    expect(rows).toHaveBeenCalledTimes(1);
  });

  test("a miss is not re-asked inside the TTL", async () => {
    const p = await pool();
    rows.mockResolvedValue({});
    await p.lookupAnalysis([A]);
    vi.setSystemTime(1_000_000 + p.MISS_TTL_MS - 1);
    expect(await p.lookupAnalysis([A])).toEqual({});
    expect(rows).toHaveBeenCalledTimes(1);
  });

  test("a miss IS re-asked after the TTL, and a row that appeared meanwhile is found", async () => {
    const p = await pool();
    rows.mockResolvedValueOnce({}).mockResolvedValueOnce({ [A]: hit });
    await p.lookupAnalysis([A]);
    vi.setSystemTime(1_000_000 + p.MISS_TTL_MS);
    expect(await p.lookupAnalysis([A])).toEqual({ [A]: hit });
    expect(rows).toHaveBeenCalledTimes(2);
  });

  test("a failed request is not recorded as a miss — the next ask fetches again", async () => {
    const p = await pool();
    rows.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ [A]: hit });
    expect(await p.lookupAnalysis([A])).toEqual({});
    expect(await p.lookupAnalysis([A])).toEqual({ [A]: hit });
    expect(rows).toHaveBeenCalledTimes(2);
  });

  test("only the unanswered ids are asked", async () => {
    const p = await pool();
    rows.mockResolvedValueOnce({ [A]: hit }).mockResolvedValueOnce({ [C]: hit });
    await p.lookupAnalysis([A, B]); // A hit, B miss
    expect(await p.lookupAnalysis([A, B, C])).toEqual({ [A]: hit, [C]: hit });
    expect(rows).toHaveBeenLastCalledWith([C]);
  });

  test("concurrent asks for the same id share one request", async () => {
    const p = await pool();
    let release!: (v: unknown) => void;
    rows.mockReturnValue(new Promise((r) => (release = r)));
    const one = p.lookupAnalysis([A]);
    const two = p.lookupAnalysis([A]);
    release({ [A]: hit });
    expect(await one).toEqual({ [A]: hit });
    expect(await two).toEqual({ [A]: hit });
    expect(rows).toHaveBeenCalledTimes(1);
  });

  test("more than 100 ids go out in chunks the server accepts", async () => {
    const p = await pool();
    rows.mockResolvedValue({});
    const ids = Array.from({ length: 150 }, (_, i) => `id${String(i).padStart(9, "0")}`);
    await p.lookupAnalysis(ids);
    expect(rows.mock.calls.map((c) => (c[0] as string[]).length)).toEqual([100, 50]);
  });
});

describe("primeAnalysis shares the pool with lookupAnalysis", () => {
  test("rows primed for a list are not fetched again by the queue", async () => {
    const p = await pool();
    rows.mockResolvedValue({ [A]: hit });
    const seen = vi.fn();
    p.subscribeAnalysis(seen);
    p.primeAnalysis([A]);
    await vi.advanceTimersByTimeAsync(200);
    expect(p.analysisState(A)).toEqual(hit);
    expect(seen).toHaveBeenCalled();
    expect(await p.lookupAnalysis([A])).toEqual({ [A]: hit });
    expect(rows).toHaveBeenCalledTimes(1);
  });
});
