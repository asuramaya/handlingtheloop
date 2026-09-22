import { describe, expect, it } from "vitest";
import { GRID_DURATION_TOLERANCE_S, mayReuseGrid } from "./gridReuse";

const V = 4;

describe("mayReuseGrid", () => {
  it("reuses a current row whose audio is the length of ours", () => {
    expect(mayReuseGrid({ version: 4, duration: 212 }, 211.6, V)).toEqual({ ok: true, why: "fits" });
  });

  it("absorbs the stored duration's rounding to whole seconds, which is all it should absorb", () => {
    // The row holds Math.round(buffer.duration); a genuine match can differ by up to a second.
    expect(mayReuseGrid({ version: 4, duration: 212 }, 211.51, V).ok).toBe(true);
    expect(mayReuseGrid({ version: 4, duration: 212 }, 212 + GRID_DURATION_TOLERANCE_S + 0.01, V)).toEqual({
      ok: false,
      why: "different-audio",
    });
  });

  it("keeps the version gate — a grid from an older detector is still refused", () => {
    expect(mayReuseGrid({ version: 3, duration: 212 }, 212, V)).toEqual({ ok: false, why: "behind-version" });
    // …and a NEWER one is fine: it is at least as good as what we would produce.
    expect(mayReuseGrid({ version: 5, duration: 212 }, 212, V).ok).toBe(true);
  });

  it("refuses a row it cannot check rather than trusting it", () => {
    // Declining costs one local derive, which re-contributes a row that carries a duration — so
    // the unverifiable case heals instead of persisting.
    expect(mayReuseGrid({ version: 4, duration: null }, 212, V)).toEqual({ ok: false, why: "unknown-duration" });
    expect(mayReuseGrid({ version: 4, duration: 212 }, 0, V)).toEqual({ ok: false, why: "unknown-duration" });
    expect(mayReuseGrid({ version: 4, duration: 212 }, NaN, V)).toEqual({ ok: false, why: "unknown-duration" });
  });

  it("names why, because a load that declined and a load with nothing to reuse are not the same event", () => {
    expect(mayReuseGrid(null, 212, V)).toEqual({ ok: false, why: "no-row" });
  });
});
