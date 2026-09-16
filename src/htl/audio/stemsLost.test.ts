import { describe, it, expect } from "vitest";
import { stemsLostOnLoad } from "./stemsLost";

// The state in which a refresh with cached stems ends up at the first node attach: stems were applied
// before the node existed, so they were marked loaded but never reached the engine.
const lostAtAttach = { nodeAttached: true, loadingStems: false, stemsLoaded: true, remote: false };

describe("stemsLostOnLoad", () => {
  it("is TRUE at the first attach after stems landed with no node — the deck must stop claiming them", () => {
    expect(stemsLostOnLoad(lostAtAttach)).toBe(true);
  });
  it("is false with no node — nothing was loaded, nothing replaced (the loss is only real at attach)", () => {
    expect(stemsLostOnLoad({ ...lostAtAttach, nodeAttached: false })).toBe(false);
  });
  it("is false when this load IS a stem load — the set is arriving, not lost", () => {
    expect(stemsLostOnLoad({ ...lostAtAttach, loadingStems: true })).toBe(false);
  });
  it("is false when the deck never claimed stems — a plain mix load, the ordinary case", () => {
    expect(stemsLostOnLoad({ ...lostAtAttach, stemsLoaded: false })).toBe(false);
  });
  it("is false on a REMOTE MIRROR — marked loaded with no local set by design, and must stay lit", () => {
    expect(stemsLostOnLoad({ ...lostAtAttach, remote: true })).toBe(false);
  });
});
