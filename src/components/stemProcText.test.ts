import { describe, expect, it } from "vitest";
import { isStemBusy, stemProcText } from "./stemProcText";
import type { StemStatus } from "../App";

const s = (o: Partial<StemStatus>): StemStatus => ({ phase: "separating", detail: "", ...o });

describe("stemProcText: the deck header names the stage, not a frozen 0%", () => {
  it("names the one-time model download, with its percentage", () => {
    expect(stemProcText(s({ step: "model", pct: 42 }))).toBe("Downloading model 42%");
    expect(stemProcText(s({ step: "model" }))).toBe("Downloading model…");
  });

  it("names GPU setup, and never shows a percentage for it (none exists)", () => {
    expect(stemProcText(s({ step: "prep" }))).toBe("Preparing GPU…");
    // A stray pct on a prep status must not resurrect the misleading number.
    expect(stemProcText(s({ step: "prep", pct: 0 }))).toBe("Preparing GPU…");
  });

  it("CONTROL: without a step, the wording is exactly what it was", () => {
    expect(stemProcText(s({ pct: 37 }))).toBe("Separating 37%");
    expect(stemProcText(s({}))).toBe("Separating…");
    expect(stemProcText(s({ phase: "downloading", src: "Demucs", pct: 12 }))).toBe("Fetching stems 12%");
  });

  it("shows nothing for phases that are chips, not progress", () => {
    for (const phase of ["ready", "cached", "failed", "unavailable", "promoted"] as const) {
      expect(stemProcText(s({ phase }))).toBeNull();
      expect(isStemBusy(s({ phase }))).toBe(false);
    }
    // A downloading status WITHOUT a source is a track load or an unsourced fetch, not stem work.
    expect(stemProcText(s({ phase: "downloading" }))).toBeNull();
    expect(stemProcText(null)).toBeNull();
  });

  it("a model or prep step still counts as busy, so the lane keeps showing it", () => {
    expect(isStemBusy(s({ step: "model", pct: 5 }))).toBe(true);
    expect(isStemBusy(s({ step: "prep" }))).toBe(true);
  });
});
