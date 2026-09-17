import { describe, expect, it } from "vitest";
import { stemRowState, type StemRowInput } from "./stemRowState";

const base: StemRowInput = { ready: false, marked: false, pending: false, otherShowsRow: false };

describe("stemRowState", () => {
  it("ready stems show the cells, whatever else is true", () => {
    expect(stemRowState({ ready: true, marked: true, pending: true, otherShowsRow: true })).toBe("cells");
  });
  it("this deck's own load shows loading", () => {
    expect(stemRowState({ ...base, pending: true })).toBe("loading");
  });
  it("BLANK: a mirror marked loaded but still waiting for envelopes shows loading, not nothing", () => {
    expect(stemRowState({ ...base, marked: true })).toBe("loading");
  });
  it("GHOST: no stems here while the other deck has them is a silent reserve, never loading", () => {
    expect(stemRowState({ ...base, otherShowsRow: true })).toBe("reserve");
  });
  it("control: no stems anywhere renders nothing", () => {
    expect(stemRowState(base)).toBe("none");
  });
});
