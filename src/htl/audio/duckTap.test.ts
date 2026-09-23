import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { DuckTap, duckTapWanted } from "./duckingHelper";
import { sourceFiles, stripComments } from "../testing/sourceScan";

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

// ★ THE TWO RESTRAINTS THAT LIVED ONLY IN PROSE. Deckard pinned the worklet watch's "it reports and
// does not repair" the same way, after observing that a copied correction is one edit from silent
// loss and nothing in the repo would object. These are the duck tap's equivalents: not what the
// code does, but the two decisions a later reader would undo in good faith.

describe("duckTapWanted — both halves, each found at cost", () => {
  it("is live only when the gate is open AND the follower is wired", () => {
    expect(duckTapWanted(true, true)).toBe(true);
    expect(duckTapWanted(true, false)).toBe(false);
    expect(duckTapWanted(false, true)).toBe(false);
    expect(duckTapWanted(false, false)).toBe(false);
  });

  it("dropping the GATE half is the 26% regression: a BYPASSED device would tap again", () => {
    // Measured: a bypassed DelayFx sat at 33.7% of its active cost with the tap live, 7.4% without.
    expect(duckTapWanted(false, true)).toBe(false);
  });

  it("dropping the WIRED half is the duck-ZERO regression, the one nobody predicted", () => {
    // setDuck severs both ends of the follower at 0, and the tap alone kept all five nodes
    // scheduled anyway — cost with the feature switched OFF.
    expect(duckTapWanted(true, false)).toBe(false);
  });
});

describe("a cut tap is refused, not read", () => {
  // Both devices guard `duckGain` with `if (!this.duckTap.on) return 1`. A severed AnalyserNode
  // keeps whatever was in its buffer when the edge went, so reading it reports PHANTOM ducking —
  // plausible, silent, and wrong. The guard reads like a redundant null-check and is not one.
  const sources = sourceFiles(join(__dirname, "..", "..")).filter((f) => /audio\/(DelayFx|ReverbFx)\.ts$/.test(f.path));

  it("found both devices (vacuity guard)", () => {
    expect(sources).toHaveLength(2);
  });

  it("each refuses the read before touching the meter buffer", () => {
    const missing = sources.filter((f) => {
      const src = stripComments(f.src);
      const guard = src.indexOf("if (!this.duckTap.on) return 1;");
      const read = src.indexOf("this.duckMeter.getFloatTimeDomainData");
      return guard < 0 || read < 0 || guard > read;
    });
    expect(missing.map((f) => f.path)).toEqual([]);
  });
});
