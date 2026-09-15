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

// ★ THE OPERATOR CORRECTED THE FRAMING: "the reverb sync is myopic. the problem occured on all
// effects reverb was just an example." They are right, and the reason every effect failed
// identically is worth pinning: eq and comp are the ONLY two Deck.ensurePadFx boots onto the
// master chain, so every OTHER effect must be added by hand — and adding was the operation that
// never propagated. So the broken set was not "reverb", it was "everything except eq and comp".
// These assert the fix is general, one case per addable kind, so no future reader has to take
// "it's generic" on trust.
describe("rackDelta is general across EVERY addable kind, not just the reported one", () => {
  const ADDABLE = ["delay", "reverb", "saturator", "crush", "mod", "gate", "noise"];

  it.each(ADDABLE)("syncs an added %s the same way", (kind) => {
    expect(rackDelta(["eq", "comp"], ["eq", kind, "comp"])).toEqual({ add: [kind], remove: [] });
  });

  it.each(ADDABLE)("syncs a removed %s the same way", (kind) => {
    expect(rackDelta(["eq", kind, "comp"], ["eq", "comp"])).toEqual({ add: [], remove: [kind] });
  });

  it("syncs the whole bank arriving at once, in the sender's order", () => {
    // A co-DJ who builds a full rack must not have it arrive one device at a time or reordered.
    expect(rackDelta(["eq", "comp"], ["eq", ...ADDABLE, "comp"]).add).toEqual(ADDABLE);
  });

  it("eq and comp are the pair that always synced — which is why the bug looked selective", () => {
    // Both resident on every deck from boot, so they were never in the `add` set and never broke.
    // A reader seeing "eq and comp work, nothing else does" should land here.
    expect(rackDelta(["eq", "comp"], ["eq", "comp"])).toEqual({ add: [], remove: [] });
  });
});
