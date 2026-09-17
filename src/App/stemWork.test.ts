import { describe, test, expect } from "vitest";
import { isStemWork } from "./stemWork";

describe("isStemWork", () => {
  test("a stem fetch and a separation are stem work", () => {
    expect(isStemWork({ phase: "downloading" })).toBe(true);
    expect(isStemWork({ phase: "separating" })).toBe(true);
  });

  test("a TRACK load in the shared slot is not, even with the same phase", () => {
    expect(isStemWork({ phase: "downloading", of: "track" })).toBe(false);
  });

  test("settled or absent statuses are not", () => {
    for (const phase of ["ready", "promoted", "cached", "failed", "unavailable"]) expect(isStemWork({ phase })).toBe(false);
    expect(isStemWork(null)).toBe(false);
    expect(isStemWork(undefined)).toBe(false);
  });
});
