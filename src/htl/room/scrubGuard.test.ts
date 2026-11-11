// The scrub flag that suppresses tick-follow (operator, 2026-11-11: session sync audit): a lost END
// must not stop following forever, and a fast start-end-start must not be cleared by the first tail.
import { describe, expect, it } from "vitest";
import { checkScrub, scrubBegin, scrubEnd, scrubIdle, scrubMove, scrubTailDone, SCRUB_WATCHDOG_MS } from "./scrubGuard";

describe("scrubGuard", () => {
  it("start → end → tail clears it", () => {
    const f = scrubIdle();
    scrubBegin(f, 0, false);
    expect(checkScrub(f, 100, false)).toBe("active");
    const tok = scrubEnd(f);
    expect(checkScrub(f, 150, false)).toBe("active"); // still in the 250 ms tail
    scrubTailDone(f, tok);
    expect(checkScrub(f, 400, false)).toBe("idle");
  });
  it("start-end-start inside the tail: the FIRST end's timer must not clear the second scratch", () => {
    const f = scrubIdle();
    scrubBegin(f, 0, false);
    const first = scrubEnd(f);
    scrubBegin(f, 100, false); // a new scratch within 250 ms
    scrubTailDone(f, first); // the first end's timer fires
    expect(checkScrub(f, 300, false)).toBe("active");
    const second = scrubEnd(f);
    scrubTailDone(f, second);
    expect(checkScrub(f, 600, false)).toBe("idle");
  });
  it("a lost END (peer dropped mid-scratch) expires after the watchdog, once", () => {
    const f = scrubIdle();
    scrubBegin(f, 0, false);
    scrubMove(f, 1000, false); // moves keep it alive
    expect(checkScrub(f, 1000 + SCRUB_WATCHDOG_MS, false)).toBe("active");
    expect(checkScrub(f, 1001 + SCRUB_WATCHDOG_MS, false)).toBe("expired");
    expect(checkScrub(f, 5000, false)).toBe("idle");
  });
  it("a move whose start was lost starts the scrub", () => {
    const f = scrubIdle();
    scrubMove(f, 10, false);
    expect(checkScrub(f, 20, false)).toBe("active");
  });
  it("this device's own hand holding the platter still keeps a LOCAL scrub alive; a peer's grip does not", () => {
    const local = scrubIdle();
    scrubBegin(local, 0, true);
    expect(checkScrub(local, 10_000, true)).toBe("active");
    const peer = scrubIdle();
    scrubBegin(peer, 0, false);
    expect(checkScrub(peer, 10_000, true)).toBe("expired");
  });
});
