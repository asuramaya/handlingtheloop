import { describe, it, expect } from "vitest";
import { isSameStemApply, stemApplyId, type HeldApply } from "./stemApply";

// A deck that has just applied `set` for track1 and still holds the float32.
function appliedDeck(set: object, over: Partial<HeldApply> = {}): HeldApply {
  return { stems: set, appliedId: stemApplyId(set), loaded: true, remote: false, neural: true, videoId: "track1", ...over };
}
const next = (stems: object | null, over: Partial<{ neural: boolean; videoId: string | null }> = {}) => ({
  stems,
  neural: true,
  videoId: "track1" as string | null,
  ...over,
});

describe("isSameStemApply — skip only a literal repeat into an engine that still holds it", () => {
  it("skips a literal repeat — the joined request re-applying the host's own result", () => {
    const set = {};
    expect(isSameStemApply(appliedDeck(set), next(set))).toBe(true);
  });

  it("STILL skips after the deck RELEASED its float32 reference — the channel the first version missed", () => {
    // The deck nulls `this.stems` after applying to free ~424 MB (mobile: at once; desktop > 8 min: after
    // the pyramid build). The engine still holds the set, so a repeat must still be skipped.
    const set = {};
    expect(isSameStemApply(appliedDeck(set, { stems: null }), next(set))).toBe(true);
  });

  it("applies after a NEW TRACK loaded, even for the same object and same track id", () => {
    // Invalidation: the engine now plays the plain mix. Skipping would leave stem controls over the mix.
    const set = {};
    expect(isSameStemApply(appliedDeck(set, { loaded: false, stems: null }), next(set))).toBe(false);
  });

  it("applies on a REMOTE MIRROR — marked loaded, but no local set in the engine", () => {
    const set = {};
    expect(isSameStemApply(appliedDeck(set, { remote: true }), next(set))).toBe(false);
  });

  it("applies when nothing was ever applied through setStems (packed load, or a reset)", () => {
    const set = {};
    expect(isSameStemApply(appliedDeck(set, { appliedId: undefined }), next(set))).toBe(false);
  });

  it("applies a NEW set even if identical in content — re-analyze must replace", () => {
    expect(isSameStemApply(appliedDeck({ vocals: 1 }), next({ vocals: 1 }))).toBe(false);
  });

  it("ALWAYS applies a clear — the plain-mix fallback", () => {
    expect(isSameStemApply(appliedDeck({}, { stems: null, loaded: false, appliedId: undefined, neural: false, videoId: null }), next(null, { neural: false, videoId: null }))).toBe(false);
  });

  it("applies when the neural flag or the track differs", () => {
    const set = {};
    expect(isSameStemApply(appliedDeck(set), next(set, { neural: false }))).toBe(false);
    expect(isSameStemApply(appliedDeck(set), next(set, { videoId: "track2" }))).toBe(false);
  });
});

describe("stemApplyId", () => {
  it("is stable per object and distinct across objects", () => {
    const a = {};
    const b = {};
    expect(stemApplyId(a)).toBe(stemApplyId(a));
    expect(stemApplyId(a)).not.toBe(stemApplyId(b));
  });
});
