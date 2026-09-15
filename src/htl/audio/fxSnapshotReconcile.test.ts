import { describe, expect, it } from "vitest";
import { rackDelta, UNDELETABLE_MASTER_KINDS } from "./fxSnapshotReconcile";

describe("rackDelta", () => {
  it("★ THE OPERATOR'S CASE: a reverb the sender added is an ADD, which the old code dropped", () => {
    // "i add reverb to master, other user does not see reverb, but eq and comp ... are there and
    // synced, just not add/removes."
    expect(rackDelta(["eq", "comp"], ["eq", "reverb", "comp"])).toEqual({ add: ["reverb"], remove: [] });
  });

  it("a device the sender removed is a REMOVE", () => {
    expect(rackDelta(["eq", "reverb", "comp"], ["eq", "comp"])).toEqual({ add: [], remove: ["reverb"] });
  });

  it("is EMPTY when membership already matches — so a param-only sync never touches the graph", () => {
    // This is the load-bearing case for audio: tearing devices down destroys live AudioNodes (a
    // reverb tail, a delay's feedback, a gate mid-cycle). A no-op delta is what keeps a co-DJ's
    // knob turn from glitching everyone else's rack.
    expect(rackDelta(["eq", "delay", "comp"], ["eq", "delay", "comp"])).toEqual({ add: [], remove: [] });
  });

  it("order alone is NOT a membership change", () => {
    expect(rackDelta(["eq", "delay", "comp"], ["comp", "delay", "eq"])).toEqual({ add: [], remove: [] });
  });

  it("NEVER removes eq or comp, even when the snapshot omits them", () => {
    // An older or partial snapshot must not be able to delete the channel EQ or the master comp.
    expect(rackDelta(["eq", "comp"], [])).toEqual({ add: [], remove: [] });
    expect(rackDelta(["eq", "comp", "gate"], [])).toEqual({ add: [], remove: ["gate"] });
    for (const k of ["eq", "comp"]) expect(UNDELETABLE_MASTER_KINDS.has(k)).toBe(true);
  });

  it("adds in the SNAPSHOT's order, so insertion follows the sender's arrangement", () => {
    expect(rackDelta(["eq"], ["eq", "gate", "delay", "reverb"]).add).toEqual(["gate", "delay", "reverb"]);
  });

  it("handles a total swap without conflating the two lists", () => {
    const d = rackDelta(["eq", "delay", "comp"], ["eq", "reverb", "comp"]);
    expect(d.add).toEqual(["reverb"]);
    expect(d.remove).toEqual(["delay"]);
  });

  it("is idempotent: applying the delta then re-deriving yields nothing to do", () => {
    const current = ["eq", "delay", "comp"];
    const snapshot = ["eq", "reverb", "comp"];
    const d = rackDelta(current, snapshot);
    const after = [...current.filter((k) => !d.remove.includes(k)), ...d.add];
    expect(rackDelta(after, snapshot)).toEqual({ add: [], remove: [] });
  });
});
