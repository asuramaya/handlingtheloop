import { describe, expect, it } from "vitest";
import { decideSpinFollow, SPIN_MAX_MS, SPIN_STILL_MS, type SpinFollowInput } from "./jogSpinFollow";

const base: SpinFollowInput = { returnsToPlay: true, vel: 0, rate: 1, msSinceTick: 0, msSinceRelease: 0 };
const d = (o: Partial<SpinFollowInput>) => decideSpinFollow({ ...base, ...o });

describe("decideSpinFollow: the physical platter stays in charge until it settles", () => {
  it("a forward fling faster than play is FOLLOWED, then handed to play once it slows to play speed", () => {
    expect(d({ vel: 3.2 })).toBe("follow");
    expect(d({ vel: 1.4 })).toBe("follow");
    expect(d({ vel: 1.0 })).toBe("handoff");
    expect(d({ vel: 0.6 })).toBe("handoff"); // released slower than play: hand back at once
  });

  it("a backward fling (spinback) is followed until it nearly stops, then the motor catches it", () => {
    expect(d({ vel: -2.5 })).toBe("follow");
    expect(d({ vel: -0.5 })).toBe("follow");
    expect(d({ vel: -0.05 })).toBe("handoff");
  });

  it("play speed is relative to the deck's tempo, not to 1×", () => {
    expect(d({ vel: 1.1, rate: 1.2 })).toBe("handoff"); // under a +20% tempo
    expect(d({ vel: 1.1, rate: 0.9 })).toBe("follow"); // still faster than a -10% tempo
  });

  it("a PAUSED deck follows any spin until the platter stops, in either direction", () => {
    expect(d({ returnsToPlay: false, vel: 0.4 })).toBe("follow");
    expect(d({ returnsToPlay: false, vel: -1.5 })).toBe("follow");
    expect(d({ returnsToPlay: false, vel: 0.4, msSinceTick: SPIN_STILL_MS })).toBe("handoff");
  });

  it("CONTROL: no ticks for the still window ends it whatever the last velocity said", () => {
    expect(d({ vel: 5, msSinceTick: SPIN_STILL_MS })).toBe("handoff");
    expect(d({ vel: 5, msSinceTick: SPIN_STILL_MS - 1 })).toBe("follow");
  });

  it("the hard cap ends a runaway spin even while ticks keep coming", () => {
    expect(d({ vel: 5, msSinceRelease: SPIN_MAX_MS })).toBe("handoff");
    expect(d({ returnsToPlay: false, vel: 2, msSinceRelease: SPIN_MAX_MS })).toBe("handoff");
  });

  it("a release with the hand held still hands back immediately (no added latency)", () => {
    expect(d({ vel: 0 })).toBe("handoff");
  });
});
