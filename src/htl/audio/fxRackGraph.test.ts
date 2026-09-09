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

// ── STEM OWNERSHIP, WHICH IS WHAT THE AUTO-MIXER BORROWS ────────────────────────────────────────
// The auto-mixer routes a stem into the user's AUTO chain for the length of a transition and hands
// it back at settle. Both halves of that lean on the rack's one-owner-per-stem partition, and on
// WHERE it is enforced — which is not where you would guess.
describe("stem ownership", () => {
  it("a chain claiming a stem still reaches the output", () => {
    const { rack, taps, out } = rackWith(4);
    rack.addChain("auto", "AUTO", 0);
    rack.setChainStems("auto", 0b0100); // VOICE
    expect(reaches(taps[2], out)).toBe(true);
  });

  // ★ THE PARTITION IS ENFORCED BY setChainStems, NOT BY addChain. addChain is a raw constructor
  // and takes the mask verbatim, so a caller that claims a stem there leaves the previous owner
  // still claiming it — and rebuild() connects that tap to EVERY chain holding the bit, which plays
  // the stem twice. Anything claiming a stem must go through setChainStems.
  it("claiming a stem through addChain does NOT displace the previous owner (why callers must not)", () => {
    const { rack } = rackWith(4);
    rack.addChain("mine", "MY VOX", 0b1100);
    rack.addChain("auto", "AUTO", 0b0100);
    expect(rack.chain("mine")?.stems).toBe(0b1100); // still claimed — two owners, vocal doubled
  });

  it("claiming it through setChainStems moves it, and it can be handed back", () => {
    const { rack } = rackWith(4);
    rack.addChain("mine", "MY VOX", 0b1100); // the user owns VOICE + INST
    rack.addChain("auto", "AUTO", 0);
    rack.setChainStems("auto", 0b0100); // the auto-mixer's actual path
    expect(rack.chain("mine")?.stems).toBe(0b1000); // VOICE moved; INST untouched
    rack.setChainStems("auto", 0); // settle: release, chain stays
    rack.setChainStems("mine", 0b1100);
    expect(rack.chain("mine")?.stems).toBe(0b1100);
  });

  // Between transitions the AUTO chain claims nothing, which is what makes it silent rather than
  // permanently in the signal path.
  it("a chain claiming no stems hears nothing", () => {
    const { rack, taps, out } = rackWith(4);
    rack.addChain("auto", "AUTO", 0);
    const deaf = rack.chain("auto");
    expect(deaf?.stems).toBe(0);
    // …while the stem itself still reaches the output, routed dry through the master.
    expect(reaches(taps[2], out)).toBe(true);
  });
});

// ── THE RACK'S TWO REGIONS ─────────────────────────────────────────────────────────────────────
//
//     [ ...the user's own chains... ][ AUTO, MIC, MASTER ]
//         freely reorderable            reserved, fixed
//
// Operator ruling 0708130a. Before it, only MASTER was pinned and it was pinned by an accident of
// implementation — addChain spliced at length-1, moveChain clamped against `masterAt`. AUTO was
// inserted before the master and then sat loose among the user's chains, so it drifted leftward as
// they reordered; MIC would have landed in the same trap the moment it existed.
//
// The invariant is asserted over SEQUENCES rather than single calls, because that is the only way
// it can fail: every individual operation looked correct before this too.
describe("FxRack chain order — reserved chains pin right, the user owns the left", () => {
  const names = (r: FxRack) => r.chainList.map((c) => c.name);
  /** The property itself, checkable after any operation: no custom chain sits right of a reserved
   *  one, the reserved block is in its declared order, and MASTER is last. */
  const holds = (r: FxRack) => {
    const ns = names(r);
    const rank = (n: string) => (n === "MASTER" ? 3 : n === "MIC" ? 2 : n === "AUTO" ? 1 : 0);
    const ranks = ns.map(rank);
    for (let i = 1; i < ranks.length; i++) if (ranks[i] !== 0 && ranks[i] < ranks[i - 1]) return false;
    for (let i = 1; i < ranks.length; i++) if (ranks[i] === 0 && ranks[i - 1] !== 0) return false;
    return ns[ns.length - 1] === "MASTER";
  };

  it("a fresh rack is just the master", () => {
    const { rack } = rackWith(0);
    expect(names(rack)).toEqual(["MASTER"]);
    expect(holds(rack)).toBe(true);
  });

  it("custom chains land left of the master, in the order they were added", () => {
    const { rack } = rackWith(0);
    rack.addChain("a", "Drums");
    rack.addChain("b", "Bass");
    expect(names(rack)).toEqual(["Drums", "Bass", "MASTER"]);
  });

  // ★ THE BUG THIS RULE FIXES. AUTO used to be inserted before the master and then left loose.
  it("AUTO pins right of every custom chain, however it was added", () => {
    const { rack } = rackWith(0);
    rack.addChain("auto", "AUTO");
    rack.addChain("a", "Drums");
    rack.addChain("b", "Bass");
    expect(names(rack)).toEqual(["Drums", "Bass", "AUTO", "MASTER"]);
    expect(holds(rack)).toBe(true);
  });

  it("MIC sits between AUTO and MASTER whatever order the three arrive in", () => {
    for (const order of [["MIC", "AUTO"], ["AUTO", "MIC"]]) {
      const { rack } = rackWith(0);
      rack.addChain("x", "Custom");
      order.forEach((n, i) => rack.addChain(`r${i}`, n));
      expect(names(rack)).toEqual(["Custom", "AUTO", "MIC", "MASTER"]);
    }
  });

  // ★ A DRAG MUST NOT BE ABLE TO PUT A USER CHAIN RIGHT OF THE MIC.
  it("no move can push a custom chain into the reserved block", () => {
    const { rack } = rackWith(0);
    rack.addChain("a", "Drums");
    rack.addChain("b", "Bass");
    rack.addChain("auto", "AUTO");
    rack.addChain("mic", "MIC");
    for (const to of [2, 3, 4, 99, -1]) {
      rack.moveChain("a", to);
      expect(holds(rack)).toBe(true);
      expect(names(rack).slice(-3)).toEqual(["AUTO", "MIC", "MASTER"]);
    }
  });

  it("a reserved chain refuses to move at all", () => {
    const { rack } = rackWith(0);
    rack.addChain("a", "Drums");
    rack.addChain("auto", "AUTO");
    rack.addChain("mic", "MIC");
    for (const id of ["auto", "mic", "master"]) {
      expect(rack.moveChain(id, 0)).toBe(false);
      expect(names(rack)).toEqual(["Drums", "AUTO", "MIC", "MASTER"]);
    }
  });

  it("customs still reorder freely among themselves", () => {
    const { rack } = rackWith(0);
    ["A", "B", "C"].forEach((n, i) => rack.addChain(`c${i}`, n));
    rack.addChain("auto", "AUTO");
    rack.moveChain("c2", 0);
    expect(names(rack)).toEqual(["C", "A", "B", "AUTO", "MASTER"]);
    expect(holds(rack)).toBe(true);
  });

  // Reserved-ness is keyed on the NAME, so a rename changes it — in either direction.
  it("renaming a custom chain to a reserved name pins it right; renaming away releases it", () => {
    const { rack } = rackWith(0);
    rack.addChain("a", "Drums");
    rack.addChain("b", "Scratch");
    expect(names(rack)).toEqual(["Drums", "Scratch", "MASTER"]);
    rack.setChainName("a", "MIC");
    expect(names(rack)).toEqual(["Scratch", "MIC", "MASTER"]);
    rack.setChainName("a", "Drums Again");
    expect(holds(rack)).toBe(true);
    expect(names(rack).slice(-1)).toEqual(["MASTER"]);
  });

  it("removing a reserved chain leaves the rest of the block intact", () => {
    const { rack } = rackWith(0);
    rack.addChain("a", "Drums");
    rack.addChain("auto", "AUTO");
    rack.addChain("mic", "MIC");
    rack.removeChain("auto");
    expect(names(rack)).toEqual(["Drums", "MIC", "MASTER"]);
    expect(holds(rack)).toBe(true);
  });

  // ★ THE SEQUENCE TEST. Every single operation looked correct before this rule too — the drift
  // only ever showed up after a run of them.
  it("survives a long mixed run of adds, moves, renames and removals", () => {
    const { rack } = rackWith(0);
    rack.addChain("auto", "AUTO");
    let n = 0;
    for (let step = 0; step < 60; step++) {
      const custom = rack.chainList.filter((c) => !["AUTO", "MIC", "MASTER"].includes(c.name));
      switch (step % 5) {
        case 0:
          rack.addChain(`k${n}`, `Chain${n++}`);
          break;
        case 1:
          if (custom.length) rack.moveChain(custom[step % custom.length].id, step % (custom.length + 3));
          break;
        case 2:
          if (step === 12) rack.addChain("mic", "MIC");
          break;
        case 3:
          if (custom.length > 2) rack.removeChain(custom[0].id);
          break;
        default:
          if (custom.length) rack.setChainName(custom[custom.length - 1].id, `R${step}`);
      }
      expect(holds(rack), `invariant broke at step ${step}: ${names(rack).join(",")}`).toBe(true);
    }
    expect(names(rack).slice(-3)).toEqual(["AUTO", "MIC", "MASTER"]);
  });
});

// ── THE MIC'S OWN DOOR ─────────────────────────────────────────────────────────────────────────
//
// A MIC chain must process the mic and NOTHING ELSE. The obvious wiring — feed it from `inject`,
// which already carries mic-to-deck — is wrong, because inject is shared by three voices: the
// scratch (Deck.connectScratch), the sampler, and the mic. A MIC chain fed from inject would run
// every scratch and every sampler pad through the mic's reverb.
//
// So the rack has a separate `micIn`, and these assert the two halves of its contract: the mic
// reaches its chain, and the other two voices do not.
describe("FxRack micIn — the MIC chain hears the mic and only the mic", () => {
  /** True when `from` reaches `to` WITHOUT passing through any node in `avoid`. */
  const reachesAvoiding = (from: StubNode, to: StubNode, avoid: StubNode[]): boolean => {
    const seen = new Set<StubNode>();
    const walk = (n: StubNode): boolean => {
      if (n === to) return true;
      if (seen.has(n) || avoid.includes(n)) return false;
      seen.add(n);
      return n.edges.some((e) => walk(e.to));
    };
    return walk(from);
  };

  it("with NO mic chain, the mic still reaches the output — adding one must be the only change", () => {
    const { rack, out } = rackWith(4);
    rack.addChain("d", "Drums", 0b0001);
    expect(reaches(rack.micIn as unknown as StubNode, out)).toBe(true);
  });

  it("with a MIC chain, the mic runs THROUGH its device", () => {
    const { rack, out } = rackWith(4);
    const mic = rack.addChain("mic", "MIC", 0);
    const rev = fakeDevice("reverb");
    rack.addDevice(mic.id, rev);
    expect(reaches(rack.micIn as unknown as StubNode, out)).toBe(true);
    // …and specifically through the reverb, not around it.
    expect(reachesAvoiding(rack.micIn as unknown as StubNode, out, [rev.input as unknown as StubNode])).toBe(false);
  });

  // ★ THE ISOLATION PROPERTY — the whole reason micIn exists rather than reusing inject.
  it("the SCRATCH and SAMPLER voices do NOT pass through the mic's chain", () => {
    const { rack, out } = rackWith(4);
    const mic = rack.addChain("mic", "MIC", 0);
    const rev = fakeDevice("reverb");
    rack.addDevice(mic.id, rev);
    const inject = rack.inject as unknown as StubNode;
    // They still reach the output…
    expect(reaches(inject, out)).toBe(true);
    // …but never by way of the mic's reverb.
    expect(reachesAvoiding(inject, out, [rev.input as unknown as StubNode])).toBe(true);
  });

  it("a MIC chain claims no stems, so it never steals a stem from the track", () => {
    const { rack, taps, out } = rackWith(4);
    rack.addChain("mic", "MIC", 0);
    // Every stem is unclaimed, so all four still reach the output dry.
    for (const t of taps) expect(reaches(t, out)).toBe(true);
  });

  it("removing the MIC chain hands the mic back to the sum — no voice is stranded", () => {
    const { rack, out } = rackWith(4);
    rack.addChain("mic", "MIC", 0);
    rack.addChain("d", "Drums", 0b0001);
    expect(reaches(rack.micIn as unknown as StubNode, out)).toBe(true);
    rack.removeChain("mic");
    expect(reaches(rack.micIn as unknown as StubNode, out)).toBe(true);
  });

  it("survives the no-stem-chains rack too — mic reaches the output with only a master", () => {
    const { rack, out } = rackWith(0);
    rack.add(fakeDevice("delay"));
    expect(reaches(rack.micIn as unknown as StubNode, out)).toBe(true);
  });
});
