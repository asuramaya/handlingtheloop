import { describe, it, expect, vi } from "vitest";
import { Reactions, Requests, Chat } from "./roomCrowd";

describe("Reactions", () => {
  it("rejects unknown emoji, accepts the set", () => {
    const r = new Reactions(() => {});
    expect(r.tap("d1", "👍")).toBe(false);
    expect(r.tap("d1", "🔥")).toBe(true);
  });

  it("rate-limits a spammer per device (10 / 2s window)", () => {
    let t = 1000;
    const r = new Reactions(() => {}, () => t);
    let ok = 0;
    for (let i = 0; i < 14; i++) if (r.tap("spammer", "🔥")) ok++;
    expect(ok).toBe(10); // 11th..14th in the same window dropped
    t += 2000; // window rolls over
    expect(r.tap("spammer", "🔥")).toBe(true);
  });

  it("flushes ONE aggregated frame with a hype level, then decays to idle", () => {
    vi.useFakeTimers();
    try {
      const frames: { counts: Record<string, number>; hype: number }[] = [];
      const r = new Reactions((m) => {
        if (m.t === "reactions") frames.push({ counts: m.counts, hype: m.hype });
      });
      r.tap("a", "🔥");
      r.tap("b", "🔥");
      r.tap("a", "🙌"); // 3 taps, one flush
      vi.advanceTimersByTime(1000);
      expect(frames.length).toBe(1);
      expect(frames[0].counts).toEqual({ "🔥": 2, "🙌": 1 });
      expect(frames[0].hype).toBeGreaterThan(0);
      // no new taps → hype decays over subsequent flushes and eventually idles at 0
      vi.advanceTimersByTime(60_000);
      expect(frames[frames.length - 1].hype).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Requests", () => {
  it("adds, caps length, ignores blank, and lists", () => {
    const q = new Requests(() => 1_000_000);
    expect(q.add("d1", "Ana", "  ")).toEqual({ ok: false, error: "" }); // blank → silent
    expect(q.add("d1", "Ana", "Rosé — APT")).toEqual({ ok: true });
    expect(q.list).toHaveLength(1);
    expect(q.list[0]).toMatchObject({ name: "Ana", text: "Rosé — APT" });
  });

  it("rate-limits one request per device per 15s", () => {
    let t = 1_000_000;
    const q = new Requests(() => t);
    expect(q.add("d1", "Ana", "first").ok).toBe(true);
    expect(q.add("d1", "Ana", "second").ok).toBe(false); // too soon
    t += 15_000;
    expect(q.add("d1", "Ana", "third").ok).toBe(true);
  });

  it("dedupes identical text case-insensitively", () => {
    let t = 0;
    const q = new Requests(() => (t += 20_000)); // each call advances past the rate window
    expect(q.add("d1", "Ana", "Rosé — APT").ok).toBe(true);
    expect(q.add("d2", "Bo", "rosé — apt")).toEqual({ ok: false, error: "Already in the queue 👍" });
  });

  it("the asker auto-upvotes; votes are idempotent per device and re-rank", () => {
    const q = new Requests(() => 1_000_000);
    q.add("ana", "Ana", "first");
    q.add("bo", "Bo", "second");
    expect(q.list[0].votes).toBe(1); // auto-vote
    const firstId = q.list.find((r) => r.text === "first")!.id;
    expect(q.vote("bo", firstId)).toBe(true); // Bo upvotes "first" → 2, leads
    expect(q.vote("bo", firstId)).toBe(false); // idempotent
    expect(q.vote("x", "nope")).toBe(false); // unknown id
    expect(q.list[0]).toMatchObject({ text: "first", votes: 2 });
    expect(q.list[1]).toMatchObject({ text: "second", votes: 1 });
  });

  it("dismiss + clear report whether they changed anything", () => {
    const q = new Requests(() => 1_000_000);
    q.add("d1", "Ana", "x");
    const id = q.list[0].id;
    expect(q.dismiss("nope")).toBe(false);
    expect(q.dismiss(id)).toBe(true);
    expect(q.list).toHaveLength(0);
    expect(q.clear()).toBe(false); // already empty
  });
});

describe("Chat", () => {
  it("posts, trims, ignores blank, and buffers history", () => {
    const c = new Chat(() => 1_000_000);
    expect(c.post("d1", "Ana", "  ", 0)).toEqual({ ok: false, error: "" }); // blank
    const r = c.post("d1", "Ana", "  hey  ", 0);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.msg).toMatchObject({ dev: "d1", name: "Ana", text: "hey" });
    expect(c.history).toHaveLength(1);
  });

  it("enforces the 1s anti-spam floor even with slow-mode off", () => {
    let t = 1_000_000;
    const c = new Chat(() => t);
    expect(c.post("d1", "Ana", "a", 0).ok).toBe(true);
    expect(c.post("d1", "Ana", "b", 0).ok).toBe(false); // <1s later
    t += 1000;
    expect(c.post("d1", "Ana", "c", 0).ok).toBe(true);
  });

  it("applies the host slow-mode gap and reports the wait", () => {
    let t = 1_000_000;
    const c = new Chat(() => t);
    expect(c.post("d1", "Ana", "a", 10).ok).toBe(true);
    t += 3000;
    const r = c.post("d1", "Ana", "b", 10); // 3s into a 10s gate
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/wait 7s/);
    t += 7000;
    expect(c.post("d1", "Ana", "c", 10).ok).toBe(true);
  });
});
