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

  // ★ WHY THE HOST USES ONE GATE PER PHASE. A gate never goes backwards, so a download that reaches 100
  // followed by separation restarting at 0 would be swallowed whole by a SHARED gate — the requester
  // would hear the download finish and then silence for the entire separation. Only a cold host hits
  // this, which is exactly why it needs pinning here rather than being found in production.
  it("a gate shared across two phases swallows the second phase; separate gates do not", () => {
    const shared = makeProgressGate(10);
    for (let p = 0; p <= 100; p += 5) shared(p); // phase 1: download completes
    let sharedPhase2 = 0;
    for (let p = 0; p <= 90; p += 5) if (shared(p) !== null) sharedPhase2++;
    expect(sharedPhase2).toBe(0); // the bug a shared gate would cause

    const load = makeProgressGate(10);
    const sep = makeProgressGate(10);
    for (let p = 0; p <= 100; p += 5) load(p);
    let separatePhase2 = 0;
    for (let p = 0; p <= 90; p += 5) if (sep(p) !== null) separatePhase2++;
    expect(separatePhase2).toBe(10); // 0,10,…,90 all heard
  });
});
