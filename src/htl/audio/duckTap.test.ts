import { describe, expect, it } from "vitest";
import { DuckTap } from "./duckingHelper";

// The tap that held the duck follower alive for the life of the device — bypassed, and even with
// duck at zero where both ends of the follower are already severed. Measured at 26.4% of a
// DelayFx's active cost (fxlab --duck-cost). What is testable in node is the RULE, not the DSP:
// the edge is cut and restored from the SOURCE, exactly once per transition, and a read through a
// cut tap is refused by the device rather than reported as silence.

class FakeNode {
  connects: unknown[] = [];
  disconnects: unknown[] = [];
  throwOnDisconnect = false;
  connect(to: unknown) {
    this.connects.push(to);
  }
  disconnect(to: unknown) {
    if (this.throwOnDisconnect) throw new Error("InvalidAccessError");
    this.disconnects.push(to);
  }
}
const tapOf = (src = new FakeNode()) => {
  const meter = {} as never;
  return { src, tap: new DuckTap(src as never, meter), meter };
};

describe("DuckTap", () => {
  it("starts believing it is wired — both devices connect the tap in their constructor", () => {
    const { tap } = tapOf();
    expect(tap.on).toBe(true);
  });

  it("cuts from the SOURCE, because an AnalyserNode has no outputs to cut", () => {
    const { src, tap, meter } = tapOf();
    tap.sync(false);
    expect(src.disconnects).toEqual([meter]);
    expect(tap.on).toBe(false);
  });

  it("is idempotent in both directions — a repeat is not a second edge", () => {
    const { src, tap } = tapOf();
    tap.sync(false);
    tap.sync(false);
    tap.sync(false);
    expect(src.disconnects).toHaveLength(1);
    tap.sync(true);
    tap.sync(true);
    expect(src.connects).toHaveLength(1);
    expect(tap.on).toBe(true);
  });

  it("restores the same edge it cut, so the UI meter comes back", () => {
    const { src, tap, meter } = tapOf();
    tap.sync(false);
    tap.sync(true);
    expect(src.connects).toEqual([meter]);
  });

  it("survives a disconnect that throws — an edge already gone is not an error", () => {
    const { src, tap } = tapOf();
    src.throwOnDisconnect = true;
    expect(() => tap.sync(false)).not.toThrow();
    // and it still records the cut, or the next sync(true) would not restore the edge
    expect(tap.on).toBe(false);
    src.throwOnDisconnect = false;
    tap.sync(true);
    expect(src.connects).toHaveLength(1);
  });

  it("CONTROL: the fake records edges at all — a spy that sees nothing proves nothing", () => {
    const { src, tap, meter } = tapOf();
    tap.sync(false);
    tap.sync(true);
    expect(src.disconnects).toEqual([meter]);
    expect(src.connects).toEqual([meter]);
  });
});
