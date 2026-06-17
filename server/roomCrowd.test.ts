import { describe, it, expect, vi } from "vitest";
import { Reactions, Requests } from "./roomCrowd";

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
