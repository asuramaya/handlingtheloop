import { describe, expect, it } from "vitest";
import { makeProgressGate } from "./progressGate";

describe("makeProgressGate", () => {
  // ★ THE PROPERTY THAT PREVENTS THE STORM. A separator can post progress hundreds of times (one per
  // segment, times shift-TTA passes). The wire must see a bounded count regardless.
  it("bounds emissions by the STEP, not by how many times progress is reported", () => {
    const gate = makeProgressGate(10);
    let emitted = 0;
    for (let i = 0; i <= 1000; i++) if (gate((i / 1000) * 100) !== null) emitted++;
    expect(emitted).toBeLessThanOrEqual(11); // 0,10,…,100
    expect(emitted).toBe(11);
  });

  it("gives the same bound for coarse and fine producers — that is what makes it independent of chunking", () => {
    const fine = makeProgressGate(10);
    const coarse = makeProgressGate(10);
    let f = 0;
    let c = 0;
    for (let i = 0; i <= 10_000; i++) if (fine((i / 10_000) * 100) !== null) f++;
    for (let i = 0; i <= 7; i++) if (coarse((i / 7) * 100) !== null) c++;
    expect(f).toBeLessThanOrEqual(11);
    expect(c).toBeLessThanOrEqual(11);
  });

  it("is monotonic — a progress value that goes backwards emits nothing", () => {
    const gate = makeProgressGate(10);
    expect(gate(55)).toBe(50);
    expect(gate(42)).toBeNull();
    expect(gate(59)).toBeNull();
    expect(gate(61)).toBe(60);
  });

  it("ignores non-finite progress rather than emitting garbage", () => {
    const gate = makeProgressGate(10);
    expect(gate(Number.NaN)).toBeNull();
    expect(gate(Number.POSITIVE_INFINITY)).toBeNull();
  });
});
