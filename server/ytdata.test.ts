import { describe, it, expect } from "vitest";
import { parseISODuration, bestThumb } from "./ytdata";

// These two helpers gate duration filtering (MAX_TRACK_SECONDS) and thumbnail
// resolution for the OAuth Data-API path. Malformed input must degrade to a
// safe 0 / null and never throw.

describe("parseISODuration", () => {
  it("parses minutes + seconds", () => {
    expect(parseISODuration("PT4M13S")).toBe(253);
  });
  it("parses hours + minutes + seconds", () => {
    expect(parseISODuration("PT1H2M3S")).toBe(3723);
  });
  it("parses hour-only", () => {
    expect(parseISODuration("PT1H")).toBe(3600);
  });
  it("parses minute-only", () => {
    expect(parseISODuration("PT2M")).toBe(120);
  });
  it("parses second-only", () => {
    expect(parseISODuration("PT45S")).toBe(45);
  });
  it("PT0S -> 0", () => {
    expect(parseISODuration("PT0S")).toBe(0);
  });
  it("empty string -> 0", () => {
    expect(parseISODuration("")).toBe(0);
  });
  it("undefined -> 0", () => {
    expect(parseISODuration(undefined)).toBe(0);
  });
  it("hour + second (skips minutes) -> correct", () => {
    expect(parseISODuration("PT1H30S")).toBe(3630);
  });

  // The regex has no anchors and every group is optional, so a string that simply
  // contains "PT" matches with all-empty groups and yields 0 — it does not throw.
  it("garbage with PT prefix -> 0 (all groups empty, no throw)", () => {
    expect(parseISODuration("PTgarbage")).toBe(0);
    expect(parseISODuration("PT")).toBe(0);
  });
  it("totally malformed (no PT) -> 0", () => {
    // NOTE: match() returns null only when "PT" is absent. "abc" has no PT -> null -> 0.
    expect(parseISODuration("abc")).toBe(0);
    expect(parseISODuration("4M13S")).toBe(0);
  });
  it("never throws on odd input", () => {
    expect(() => parseISODuration("P1Y2M3DT4H5M6S")).not.toThrow();
  });
});

describe("bestThumb", () => {
  it("prefers maxres over everything", () => {
    expect(
      bestThumb({
        maxres: { url: "max" },
        standard: { url: "std" },
        high: { url: "hi" },
        medium: { url: "med" },
        default: { url: "def" },
      }),
    ).toBe("max");
  });
  it("standard when no maxres", () => {
    expect(
      bestThumb({ standard: { url: "std" }, high: { url: "hi" }, default: { url: "def" } }),
    ).toBe("std");
  });
  it("high when no maxres/standard", () => {
    expect(bestThumb({ high: { url: "hi" }, medium: { url: "med" } })).toBe("hi");
  });
  it("medium when only medium + default", () => {
    expect(bestThumb({ medium: { url: "med" }, default: { url: "def" } })).toBe("med");
  });
  it("default as last resort", () => {
    expect(bestThumb({ default: { url: "def" } })).toBe("def");
  });
  it("empty object -> null", () => {
    expect(bestThumb({})).toBeNull();
  });
  it("undefined -> null", () => {
    expect(bestThumb(undefined)).toBeNull();
  });
});
