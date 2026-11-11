// The intent outbox (operator, 2026-11-11: session sync audit): what a reconnecting device holds,
// and what it is allowed to forget.
import { describe, it, expect } from "vitest";
import { IntentOutbox } from "./outbox";
import type { Intent } from "./protocol";

const kinds = (xs: Intent[]) => xs.map((i) => i.kind);

describe("IntentOutbox", () => {
  it("keeps discrete intents in order", () => {
    const o = new IntentOutbox();
    o.push({ kind: "load", deck: "A", videoId: "v" }, 0);
    o.push({ kind: "loop", deck: "A", action: "in" }, 1);
    o.push({ kind: "transport", deck: "A", action: "play" }, 2);
    expect(kinds(o.drain(3))).toEqual(["load", "loop", "transport"]);
    expect(o.size).toBe(0);
  });

  it("coalesces a sweep to its last value per target", () => {
    const o = new IntentOutbox();
    for (let i = 0; i <= 10; i++) o.push({ kind: "crossfade", value: i / 10 }, i);
    o.push({ kind: "control", deck: "A", param: "level", value: 0.2 }, 11);
    o.push({ kind: "control", deck: "B", param: "level", value: 0.3 }, 12);
    o.push({ kind: "control", deck: "A", param: "level", value: 0.9 }, 13);
    const out = o.drain(14);
    expect(out).toEqual([
      { kind: "crossfade", value: 1 },
      { kind: "control", deck: "B", param: "level", value: 0.3 },
      { kind: "control", deck: "A", param: "level", value: 0.9 },
    ]);
  });

  it("moves a coalesced value AFTER a discrete intent that came between (fxParam after fxRack)", () => {
    const o = new IntentOutbox();
    o.push({ kind: "fxParam", deck: "A", slot: 0, param: "mix", value: 0.1, chain: "master", fx: "delay" }, 0);
    o.push({ kind: "fxRack", deck: "A", rack: [] }, 1);
    o.push({ kind: "fxParam", deck: "A", slot: 1, param: "mix", value: 0.8, chain: "master", fx: "delay" }, 2);
    expect(kinds(o.drain(3))).toEqual(["fxRack", "fxParam"]);
  });

  it("is capped, shedding the OLDEST", () => {
    const o = new IntentOutbox(3, 10_000);
    for (let i = 0; i < 5; i++) o.push({ kind: "hotcue", deck: "A", slot: i, action: "press" }, i);
    const out = o.drain(5) as { slot: number }[];
    expect(out.map((x) => x.slot)).toEqual([2, 3, 4]);
    expect(o.dropped).toBe(2);
  });

  it("forgets anything older than the age limit — a stale gesture is worse than a lost one", () => {
    const o = new IntentOutbox(200, 10_000);
    o.push({ kind: "load", deck: "A", videoId: "old" }, 0);
    o.push({ kind: "load", deck: "B", videoId: "new" }, 9_000);
    const out = o.drain(12_000) as { videoId: string }[];
    expect(out.map((x) => x.videoId)).toEqual(["new"]);
  });
});
