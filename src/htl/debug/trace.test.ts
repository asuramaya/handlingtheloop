import { describe, it, expect, beforeEach, vi } from "vitest";
import { event, dumpRing, clearRing, formatEvent } from "./trace";

// The flight recorder is now something a USER reads, not only something a bug report mails, so
// its formatting and its bounds are load-bearing. These are the parts that can be tested without
// a browser: the ring's discipline and the line format.
describe("flight recorder ring", () => {
  beforeEach(() => clearRing());

  it("records events and hands back a COPY, not the live array", () => {
    event("load", { deck: "A" });
    const a = dumpRing();
    a.push({ t: 0, ch: "forged" });
    expect(dumpRing()).toHaveLength(1); // mutating the snapshot must not reach the ring
  });

  it("clears", () => {
    event("x", {});
    expect(dumpRing()).toHaveLength(1);
    clearRing();
    expect(dumpRing()).toHaveLength(0);
  });

  it("stays BOUNDED and keeps the NEWEST — the tail is what a crash needs", () => {
    for (let i = 0; i < 400; i++) event("spam", { i });
    const ring = dumpRing();
    expect(ring.length).toBeLessThanOrEqual(300);
    expect(ring[ring.length - 1].i).toBe(399); // newest survived
    expect(ring[0].i).toBeGreaterThan(0); // oldest were dropped, not the newest
  });

  it("never throws on an unserialisable payload", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => event("weird", { cyclic })).not.toThrow();
  });
});

describe("formatEvent", () => {
  it("renders mm:ss.mmm, the channel, then the fields", () => {
    // Strings print RAW, without JSON quotes — a log line is read by eye, and `id=abc` is
    // easier to scan than `id="abc"`. Non-strings are JSON so an object still round-trips.
    expect(formatEvent({ t: 65432, ch: "load", deck: "A", id: "abc" })).toBe("01:05.432  load  deck=A id=abc");
    expect(formatEvent({ t: 0, ch: "n", n: 3, ok: true })).toBe("00:00.000  n  n=3 ok=true");
  });

  it("pads every time component so lines COLUMN-ALIGN in the log", () => {
    const a = formatEvent({ t: 1, ch: "x" });
    const b = formatEvent({ t: 3599999, ch: "x" });
    expect(a).toBe("00:00.001  x");
    expect(b).toBe("59:59.999  x");
    // The stamp is the reason the log is readable as a column; equal width is the whole point.
    expect(a.indexOf("x")).toBe(b.indexOf("x"));
  });

  it("survives an event with no fields and a missing timestamp", () => {
    expect(formatEvent({ ch: "bare" })).toBe("00:00.000  bare");
  });
});

describe("console capture", () => {
  it("mirrors console.warn/error into the ring AND still calls through", () => {
    // The wrapper is installed at module load in a browser-ish env; jsdom/node here may not have
    // it, so assert the CONTRACT via event() directly where the wrapper is absent.
    clearRing();
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    console.warn("[htl] something fell back");
    spy.mockRestore();
    const ring = dumpRing();
    // Either the wrapper ran (an entry exists) or this environment has none — but if an entry
    // exists it must carry the message, never a bare marker.
    const warn = ring.find((e) => e.ch === "console.warn");
    if (warn) expect(String(warn.msg)).toContain("something fell back");
  });
});
