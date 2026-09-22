import { describe, expect, it } from "vitest";
import { headroomGain, MAX_HEADROOM_DB } from "./masterHeadroom";

describe("headroomGain", () => {
  it("0 dB is unity — the default changes nobody's sound", () => {
    expect(headroomGain(0)).toBe(1);
  });
  it("-3 dB is the measured fix (0.02 dB of duck left)", () => {
    expect(headroomGain(-3)).toBeCloseTo(0.7079, 4);
  });
  it("-6 dB halves the voltage", () => {
    expect(headroomGain(-6)).toBeCloseTo(0.5012, 4);
  });
  it("clamps past the floor instead of vanishing", () => {
    expect(headroomGain(-60)).toBe(headroomGain(-MAX_HEADROOM_DB));
  });
  it("a corrupt value is unity, not silence — NaN", () => {
    expect(headroomGain(NaN)).toBe(1);
  });
  it("control: a POSITIVE value never becomes boost into the limiter", () => {
    expect(headroomGain(6)).toBe(1);
  });
});
