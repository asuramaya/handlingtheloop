import { describe, expect, it } from "vitest";
import { matches } from "./settingsSearch";

describe("settings search matching", () => {
  it("every word must appear, in any order, any case", () => {
    expect(matches("Brake — Pause's motor spin-down", "motor pause")).toBe(true);
    expect(matches("Brake — Pause's motor spin-down", "MOTOR")).toBe(true);
    expect(matches("Brake — Pause's motor spin-down", "motor play")).toBe(false);
  });

  it("CONTROL: an empty or whitespace query matches everything", () => {
    expect(matches("anything", "   ")).toBe(true);
  });
});
