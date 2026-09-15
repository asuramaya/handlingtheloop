import { describe, expect, it } from "vitest";
import { FxRack, type FxDevice } from "./Fx";

// DID THE RACK WORK BREAK STEM ROUTING? No — and this is the proof, kept so nobody has to re-ask.
//
// The operator reported "chains with stem selections do not apply their effects at all, only
// master works" on version d4237388. That deploy carried two of my changes to this exact file —
// 1cf308d (the two-region reserved ordering) and 9cdeb4f (micIn, the mic's own entry) — so the
// first duty was to falsify MY OWN commits before looking anywhere else, not to reason about
// whose fault it probably was.
//
// ★ WHAT THESE ASSERT, and it is deliberately the graph and not the UI: with LIVE TAPS a stem
// chain's claimed stem passes THROUGH its devices, an unclaimed stem does not, and both still
// reach the output. That holds with AUTO and MIC present, which is the arrangement the two-region
// ordering produces. So rebuild() routes correctly and the reported symptom is not a routing
// regression.
//
// The third case is the symptom itself, pinned as DESIGNED behaviour rather than left ambiguous:
// with no taps the chain's device processes nothing and the track plays dry through the fallback.
// Deck.syncStemTaps explains why that fallback is right — a "drums" chain fed from one
// unseparated group would process the whole track, which looks routed and sounds wrong. The real
// defect is that this state was INVISIBLE, and that is Metron's chainRouting work, not this file's.

interface Edge { to: StubNode }
class StubNode {
  edges: Edge[] = [];
  get context() { return ctx; }
  constructor(readonly label: string) {}
  connect(to: StubNode) { this.edges.push({ to }); return to; }
  disconnect() { this.edges = []; }
}
let n = 0;
const ctx = { createGain: () => new StubNode(`g${n++}`) } as unknown as AudioContext;

function reaches(from: StubNode, to: StubNode, seen = new Set<StubNode>()): boolean {
  if (from === to) return true;
  if (seen.has(from)) return false;
  seen.add(from);
  return from.edges.some((e) => reaches(e.to, to, seen));
}
function fakeDevice(kind: string): FxDevice {
  const input = new StubNode(`${kind}.in`);
  const output = new StubNode(`${kind}.out`);
  input.connect(output);
  return {
    kind, input, output, degraded: false, bypassed: false,
    setBypass() {}, reset() {}, resetParams() {},
    snapshotParams: () => ({}), setParam() {}, getParam: () => 0, paramDefault: () => 0, dispose() {},
  } as unknown as FxDevice;
}
function rackWithTaps() {
  const rack = new FxRack(ctx);
  const taps = Array.from({ length: 4 }, (_, i) => new StubNode(`tap${i}`));
  rack.setStemSource((i) => taps[i] as unknown as AudioNode);
  return { rack, taps, out: rack.output as unknown as StubNode };
}

describe("a stem chain processes its own stem and only its own", () => {
  it("the claimed stem goes THROUGH the chain's device", () => {
    const { rack, taps, out } = rackWithTaps();
    const c = rack.addChain("c1", "DRUMS", 0b0001);
    const dev = fakeDevice("gate");
    rack.addDevice(c.id, dev);
    expect(reaches(taps[0], dev.input as unknown as StubNode)).toBe(true);
    expect(reaches(taps[0], out)).toBe(true);
  });

  it("an UNclaimed stem bypasses that device and is still heard", () => {
    // The other half, and the one a careless fix breaks: an unclaimed stem must run DRY to the
    // sum, not through somebody else's reverb, and must not go missing either.
    const { rack, taps, out } = rackWithTaps();
    const c = rack.addChain("c1", "DRUMS", 0b0001);
    const dev = fakeDevice("gate");
    rack.addDevice(c.id, dev);
    expect(reaches(taps[1], dev.input as unknown as StubNode)).toBe(false);
    expect(reaches(taps[1], out)).toBe(true);
  });

  it("★ still routes with AUTO and MIC present — the two-region arrangement", () => {
    // 1cf308d puts reserved chains to the right of the user's; 9cdeb4f gives the mic its own
    // entry. Both shipped in the version the bug was reported against, so both are on trial here.
    const { rack, taps, out } = rackWithTaps();
    const drums = rack.addChain("c1", "DRUMS", 0b0001);
    rack.addChain("c2", "AUTO", 0);
    rack.addChain("c3", "MIC", 0);
    const dev = fakeDevice("gate");
    rack.addDevice(drums.id, dev);
    expect(reaches(taps[0], dev.input as unknown as StubNode)).toBe(true);
    expect(reaches(taps[0], out)).toBe(true);
    // And the mic's own door still lands somewhere — a MIC chain exists, so it is that chain.
    expect(reaches(rack.micIn as unknown as StubNode, out)).toBe(true);
  });
});

describe("with NO stems the chain is inert, and the deck still plays", () => {
  it("reproduces the reported symptom, and pins it as designed", () => {
    const rack = new FxRack(ctx);
    const c = rack.addChain("c1", "VOICE", 0b0100);
    const dev = fakeDevice("reverb");
    rack.addDevice(c.id, dev);
    const out = rack.output as unknown as StubNode;
    // The track is heard — the dry fallback carries it, which is why nothing sounds "broken".
    expect(reaches(rack.input as unknown as StubNode, out)).toBe(true);
    // …and nothing reaches the chain's device. This is the operator's "nothing going through the
    // chain, only the master works", exactly, and it is the fallback behaving correctly.
    expect(reaches(rack.input as unknown as StubNode, dev.input as unknown as StubNode)).toBe(false);
  });
});
