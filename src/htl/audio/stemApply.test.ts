import { describe, it, expect } from "vitest";
import { isSameStemApply } from "./stemApply";

const set = { vocals: 1 };
const held = { stems: set, neural: true, videoId: "track1" };

describe("isSameStemApply", () => {
  it("skips a LITERAL repeat — the joined request re-applying the host's own result", () => {
    expect(isSameStemApply(held, { stems: set, neural: true, videoId: "track1" })).toBe(true);
  });
  it("applies a NEW set even if identical in content — re-analyze must replace", () => {
    expect(isSameStemApply(held, { stems: { vocals: 1 }, neural: true, videoId: "track1" })).toBe(false);
  });
  it("ALWAYS applies a clear, even when the deck is already clear — the plain-mix fallback", () => {
    const clear = { stems: null, neural: false, videoId: null };
    expect(isSameStemApply(clear, clear)).toBe(false);
  });
  it("applies when the neural flag differs (a DSP → neural upgrade)", () => {
    expect(isSameStemApply(held, { stems: set, neural: false, videoId: "track1" })).toBe(false);
  });
  it("applies when the track differs", () => {
    expect(isSameStemApply(held, { stems: set, neural: true, videoId: "track2" })).toBe(false);
  });
});
