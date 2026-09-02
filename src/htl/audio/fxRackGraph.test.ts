import { describe, expect, it } from "vitest";
import { FxRack, type FxDevice } from "./Fx";

// IS THE SIGNAL ACTUALLY CONNECTED TO ANYTHING?
//
// FxRack builds a Web Audio graph, and a graph bug does not throw — it goes quiet, or it plays
// something twice, and you find out by ear weeks later. That is exactly how the scratch
// regression happened: once stems were separated, each chain was fed from the stretch worklet's
// per-stem taps and `chainIn` was deliberately left unconnected (the taps already carry the
// track — connecting it too would play it twice). The SCRATCH voice enters the same node and
// appears on no tap, so it was dropped along with it. A scrub faded the deck down and faded
// nothing in.
//
// No audio here and none claimed. These are stub nodes that record their edges, and the only
// question asked is REACHABILITY: can this input still get to the output?

interface Edge {
  to: StubNode;
}
class StubNode {
  edges: Edge[] = [];
  /** FxRack reaches back through a node for the context when it needs a new gain. */
  get context() {
    return ctx;
  }
  constructor(readonly label: string) {}
  connect(to: StubNode) {
    this.edges.push({ to });
    return to;
  }
  disconnect() {
    this.edges = [];
  }
}
let n = 0;
const ctx = { createGain: () => new StubNode(`g${n++}`) } as unknown as AudioContext;


/** Can `from` reach `to` by following connections? */
function reaches(from: StubNode, to: StubNode, seen = new Set<StubNode>()): boolean {
  if (from === to) return true;
  if (seen.has(from)) return false;
  seen.add(from);
  return from.edges.some((e) => reaches(e.to, to, seen));
}
/** How many DISTINCT paths — two means the same signal arrives twice. */
function paths(from: StubNode, to: StubNode): number {
  if (from === to) return 1;
  return from.edges.reduce((acc, e) => acc + paths(e.to, to), 0);
}

function fakeDevice(kind: string, degraded = false): FxDevice {
  const input = new StubNode(`${kind}.in`);
  const output = new StubNode(`${kind}.out`);
  input.connect(output); // a device passes signal through
  const params: Record<string, number> = {};
  return {
    kind,
    input,
    output,
    degraded,
    bypassed: false,
    setBypass(on: boolean) {
      (this as { bypassed: boolean }).bypassed = on;
    },
    reset() {},
    resetParams() {},
    snapshotParams: () => ({ ...params }),
    setParam(id: string, v: number) {
      params[id] = v;
    },
    getParam: (id: string) => params[id] ?? 0,
    paramDefault: () => 0,
    dispose() {},
  } as unknown as FxDevice;
}

/** A rack with `taps` live stem taps, as a deck with separated stems provides. */
function rackWith(tapCount: number) {
  const rack = new FxRack(ctx);
  const taps = Array.from({ length: 4 }, (_, i) => new StubNode(`tap${i}`));
  if (tapCount > 0) rack.setStemSource((i) => (i < tapCount ? (taps[i] as unknown as AudioNode) : null));
  return { rack, taps, out: rack.output as unknown as StubNode };
}

describe("FxRack graph — every input reaches the output", () => {
  it("plain rack, no stem chains: source and injected voices both arrive", () => {
    const { rack, out } = rackWith(0);
    rack.add(fakeDevice("delay"));
    expect(reaches(rack.input as unknown as StubNode, out)).toBe(true);
    expect(reaches(rack.inject as unknown as StubNode, out)).toBe(true);
  });

  it("★ with a stem chain and LIVE taps, an injected voice still arrives", () => {
    const { rack, taps, out } = rackWith(4);
    const c = rack.addChain("c1", "DRUMS", 0b0001);
    rack.addDevice(c.id, fakeDevice("gate"));
    // The regression, stated: the scratch worklet, the sampler's deck pads and the mic all
    // connect here and nothing else carries them.
    expect(reaches(rack.inject as unknown as StubNode, out)).toBe(true);
    // …and each live tap reaches the output too, claimed or not (an unclaimed stem runs dry).
    for (const t of taps) expect(reaches(t, out)).toBe(true);
  });

  it("★ the main source is NOT doubled when the taps carry it", () => {
    const { rack, out } = rackWith(4);
    rack.addChain("c1", "DRUMS", 0b0001);
    // `input` must NOT reach the output while live taps exist — the taps are the same signal, and
    // a second path would play the track twice. This is the constraint the fix had to respect.
    expect(reaches(rack.input as unknown as StubNode, out)).toBe(false);
    expect(paths(rack.inject as unknown as StubNode, out)).toBe(1);
  });

  it("no taps yet (a rack built before the stems land): the source falls back in, once", () => {
    const { rack, out } = rackWith(0);
    rack.addChain("c1", "DRUMS", 0b0001);
    expect(reaches(rack.input as unknown as StubNode, out)).toBe(true);
    expect(paths(rack.input as unknown as StubNode, out)).toBe(1);
    expect(reaches(rack.inject as unknown as StubNode, out)).toBe(true);
  });

  it("survives a rebuild — removing a chain re-wires both inputs, and neither doubles", () => {
    const { rack, out } = rackWith(4);
    const c = rack.addChain("c1", "DRUMS", 0b0001);
    rack.removeChain(c.id);
    expect(reaches(rack.inject as unknown as StubNode, out)).toBe(true);
    expect(paths(rack.inject as unknown as StubNode, out)).toBe(1);
    expect(paths(rack.input as unknown as StubNode, out)).toBe(1);
  });
});

// A worklet-backed device built before addModule() landed carries audio without processing it.
// That used to be permanent: a COMP restored from a saved rack at boot could race the modules and
// come back a pass-through, looking completely normal — "the compressor sometimes does nothing".
describe("FxRack.rebuildDegraded — repairing a device that lost the worklet race", () => {
  it("replaces it in place, carrying params and bypass across", () => {
    const { rack } = rackWith(0);
    const dead = fakeDevice("comp", true);
    rack.add(dead);
    rack.add(fakeDevice("delay"));
    dead.setParam("threshold", -18);
    dead.setBypass(true, true);

    const rebuilt = rack.rebuildDegraded((kind) => fakeDevice(kind));
    expect(rebuilt).toBe(1);
    const comp = rack.list[0];
    expect(comp).not.toBe(dead); // a NEW instance
    expect(comp.degraded).toBeFalsy();
    expect(comp.getParam("threshold")).toBe(-18);
    expect(comp.bypassed).toBe(true);
    expect(rack.list.map((d) => d.kind)).toEqual(["comp", "delay"]); // same position
  });

  it("leaves healthy devices alone and reports nothing to do", () => {
    const { rack } = rackWith(0);
    const ok = fakeDevice("delay");
    rack.add(ok);
    expect(rack.rebuildDegraded((kind) => fakeDevice(kind))).toBe(0);
    expect(rack.list[0]).toBe(ok);
  });

  it("gives up rather than churning when the worklet is STILL unavailable", () => {
    const { rack } = rackWith(0);
    const dead = fakeDevice("comp", true);
    rack.add(dead);
    expect(rack.rebuildDegraded((kind) => fakeDevice(kind, true))).toBe(0);
    expect(rack.list[0]).toBe(dead);
  });

  it("repairs inside a stem chain too, and the rack still routes afterwards", () => {
    const { rack, out } = rackWith(4);
    const c = rack.addChain("c1", "DRUMS", 0b0001);
    rack.addDevice(c.id, fakeDevice("comp", true));
    expect(rack.rebuildDegraded((kind) => fakeDevice(kind))).toBe(1);
    expect(reaches(rack.inject as unknown as StubNode, out)).toBe(true);
    expect(paths(rack.inject as unknown as StubNode, out)).toBe(1);
  });
});
