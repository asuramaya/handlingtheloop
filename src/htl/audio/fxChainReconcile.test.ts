import { describe, expect, it } from "vitest";
import { chainPlan, planIsStructural, type LiveChain } from "./fxChainReconcile";
import type { FxChainSlot } from "../room/protocol";

const dev = (kind: string) => ({ kind, params: {}, bypassed: false });
const snap = (name: string, kinds: string[], stems = 0): FxChainSlot => ({ name, stems, devices: kinds.map(dev) }) as unknown as FxChainSlot;
const live = (id: string, name: string, kinds: string[], stems = 0): LiveChain => ({ id, name, stems, devices: kinds });

describe("chainPlan", () => {
  // ★ THE REGRESSION. The operator's gesture: chain 1 exists with a device, a reverb is added to it.
  // The old code removed EVERY non-master chain and rebuilt all of them, destroying the live nodes
  // of chains that had not changed at all.
  it("adding a device to one chain leaves every OTHER chain untouched", () => {
    const current = [live("c1", "vocals", ["delay"]), live("c2", "drums", ["gate"])];
    const p = chainPlan(current, [snap("vocals", ["delay", "reverb"]), snap("drums", ["gate"])]);
    expect(p.remove).toEqual([]);
    expect(p.add).toEqual([]);
    expect(p.keep).toHaveLength(2);
    const vocals = p.keep.find((k) => k.id === "c1")!;
    const drums = p.keep.find((k) => k.id === "c2")!;
    expect(vocals.addDevices).toEqual(["reverb"]);
    expect(vocals.removeDevices).toEqual([]);
    // The chain nobody touched must have NOTHING to do — this is the whole point.
    expect(drums.addDevices).toEqual([]);
    expect(drums.removeDevices).toEqual([]);
    expect(drums.stemsChanged).toBe(false);
  });

  it("removes a device without rebuilding the chain", () => {
    const p = chainPlan([live("c1", "vocals", ["delay", "reverb"])], [snap("vocals", ["delay"])]);
    expect(p.keep[0].removeDevices).toEqual(["reverb"]);
    expect(p.keep[0].addDevices).toEqual([]);
    expect(p.remove).toEqual([]);
  });

  it("matches by NAME, not by id or position — ids are per-deck sequence numbers", () => {
    const p = chainPlan([live("c7", "drums", ["gate"]), live("c2", "vocals", ["delay"])], [snap("vocals", ["delay"]), snap("drums", ["gate"])]);
    expect(p.add).toEqual([]);
    expect(p.remove).toEqual([]);
    expect(p.keep.find((k) => k.id === "c2")!.snapshot.name).toBe("vocals");
    expect(p.keep.find((k) => k.id === "c7")!.snapshot.name).toBe("drums");
  });

  it("pairs duplicate names one-to-one instead of binding both to the same entry", () => {
    const p = chainPlan([live("c1", "fx", ["delay"]), live("c2", "fx", ["gate"])], [snap("fx", ["delay"]), snap("fx", ["gate"])]);
    expect(p.keep).toHaveLength(2);
    expect(p.remove).toEqual([]);
    expect(p.add).toEqual([]);
    expect(p.keep.map((k) => k.id).sort()).toEqual(["c1", "c2"]);
  });

  it("adds a genuinely new chain and removes a genuinely absent one", () => {
    const p = chainPlan([live("c1", "vocals", ["delay"])], [snap("drums", ["gate"])]);
    expect(p.remove).toEqual(["c1"]);
    expect(p.add.map((c) => c.name)).toEqual(["drums"]);
    expect(p.keep).toEqual([]);
  });

  it("notices a stem claim change without touching devices", () => {
    const p = chainPlan([live("c1", "vocals", ["delay"], 1)], [snap("vocals", ["delay"], 3)]);
    expect(p.keep[0].stemsChanged).toBe(true);
    expect(p.keep[0].addDevices).toEqual([]);
    expect(p.keep[0].removeDevices).toEqual([]);
  });

  // An unknown kind is not a removal instruction — rackDelta's rule, restated here because the
  // failure it prevents (an older build silently deleting a newer peer's device) is the same.
  it("never removes a device kind this build does not understand", () => {
    const known = new Set(["delay", "reverb"]);
    const p = chainPlan([live("c1", "vocals", ["delay", "quantumfoldback"])], [snap("vocals", ["delay"])], known);
    expect(p.keep[0].removeDevices).toEqual([]);
    expect(p.keep[0].addDevices).toEqual([]);
  });

  it("does not try to ADD an unknown kind a newer peer sent", () => {
    const known = new Set(["delay"]);
    const p = chainPlan([live("c1", "vocals", ["delay"])], [snap("vocals", ["delay", "quantumfoldback"])], known);
    expect(p.keep[0].addDevices).toEqual([]);
  });

  it("carries the sender's device order for a caller that can reorder in place", () => {
    const p = chainPlan([live("c1", "vocals", ["reverb", "delay"])], [snap("vocals", ["delay", "reverb"])]);
    expect(p.keep[0].order).toEqual(["delay", "reverb"]);
    expect(p.keep[0].addDevices).toEqual([]);
    expect(p.keep[0].removeDevices).toEqual([]);
  });
});

describe("planIsStructural", () => {
  it("is false when nothing structural changed, so the caller can take the params-in-place path", () => {
    const p = chainPlan([live("c1", "vocals", ["delay"], 2)], [snap("vocals", ["delay"], 2)]);
    expect(planIsStructural(p)).toBe(false);
  });

  it("is true for an added device, a removed chain, or a stem change", () => {
    expect(planIsStructural(chainPlan([live("c1", "v", ["delay"])], [snap("v", ["delay", "reverb"])]))).toBe(true);
    expect(planIsStructural(chainPlan([live("c1", "v", ["delay"])], []))).toBe(true);
    expect(planIsStructural(chainPlan([live("c1", "v", ["delay"], 1)], [snap("v", ["delay"], 2)]))).toBe(true);
  });
});
