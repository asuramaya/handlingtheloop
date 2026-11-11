// Client liveness (operator, 2026-11-11: session sync audit): pong-based for every role, inbound
// staleness only where ticks are expected.
import { describe, it, expect } from "vitest";
import { livenessVerdict, type LivenessInput } from "./liveness";

const base: LivenessInput = {
  now: 100_000,
  online: true,
  hasSocket: true,
  pingOutstandingSince: 0,
  pongTimeoutMs: 10_000,
  ticksExpected: false,
  lastRecvAt: 99_000,
  staleMs: 6_000,
};

describe("livenessVerdict", () => {
  it("a socket stuck CLOSING while we still say online is dead after the grace (the never-firing onclose)", () => {
    expect(livenessVerdict({ ...base, notOpenSince: 98_000 })).toBe("not-open");
    expect(livenessVerdict({ ...base, notOpenSince: 99_500 })).toBe("ok");
  });

  it("an unanswered ping past the timeout is dead — for the ANCHOR too (no follower condition)", () => {
    expect(livenessVerdict({ ...base, pingOutstandingSince: 89_000 })).toBe("no-pong");
  });

  it("a ping still inside the timeout is fine", () => {
    expect(livenessVerdict({ ...base, pingOutstandingSince: 95_000 })).toBe("ok");
  });

  it("a quiet device with nothing outstanding is NOT dead (a throttled tab that sent no ping)", () => {
    expect(livenessVerdict({ ...base, lastRecvAt: 30_000 })).toBe("ok");
  });

  it("a follower with ticks expected goes stale on inbound silence", () => {
    expect(livenessVerdict({ ...base, ticksExpected: true, lastRecvAt: 93_000 })).toBe("stale");
  });

  it("control: no ticks expected → a slow pong cannot trip inbound staleness (the old false positive)", () => {
    expect(livenessVerdict({ ...base, ticksExpected: false, lastRecvAt: 93_000 })).toBe("ok");
  });

  it("offline / connecting is never judged here", () => {
    expect(livenessVerdict({ ...base, online: false, pingOutstandingSince: 1 })).toBe("ok");
  });
});
