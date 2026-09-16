import { describe, expect, it } from "vitest";
import { separationForces } from "./separatePurpose";

describe("separationForces", () => {
  // A remote request must NOT force: forced loadStems calls start their own job on purpose, so forcing
  // here re-creates the duplicate separation that loadStems' dedupe exists to prevent.
  it("a remote request does not force a fresh separation", () => {
    expect(separationForces("request")).toBe(false);
  });
  // The opposite control: Re-analyze must still force, or a deliberate higher-quality recompute would
  // be silently swallowed by an existing job whose key does not include shift-TTA quality.
  it("a re-analyze still forces", () => {
    expect(separationForces("reanalyze")).toBe(true);
  });
});
