import { describe, expect, it, beforeEach, vi, afterEach } from "vitest";
import { join } from "node:path";
import { sourceFiles } from "../testing/sourceScan";
import { watchProcessor, resetWorkletWatch, type ProcessorErrorTarget } from "./workletWatch";
import { clearRing, dumpRing } from "../debug/trace";

// A worklet processor that throws goes PERMANENTLY SILENT and reports through exactly one channel:
// onprocessorerror. Measured, not cited — a processor throwing on block 10 of a 375-block render
// sounds for 10 blocks and outputs silence for the other 365. Nothing is thrown where a caller can
// catch it, so a node nobody watched is a deck (or a master bus) that goes quiet with a clean console.

const fakeNode = (): ProcessorErrorTarget => ({ onprocessorerror: null });
const fire = (n: ProcessorErrorTarget) => n.onprocessorerror?.(new Event("error") as ErrorEvent);

describe("watchProcessor", () => {
  beforeEach(() => {
    resetWorkletWatch();
    clearRing();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("attaches the handler — an unwatched node is the whole defect", () => {
    const n = fakeNode();
    expect(n.onprocessorerror).toBeNull();
    watchProcessor(n, "comp");
    expect(typeof n.onprocessorerror).toBe("function");
  });

  it("says it once per KIND on the console — a rack rebuild is the same silence heard again", () => {
    const a = fakeNode();
    const b = fakeNode();
    watchProcessor(a, "comp");
    watchProcessor(b, "comp");
    fire(a);
    fire(b);
    expect(console.error).toHaveBeenCalledTimes(1);
  });

  it("but records EVERY incident in the ring — that is the record a bug report dumps", () => {
    const a = fakeNode();
    const b = fakeNode();
    watchProcessor(a, "stretch", "deck A");
    watchProcessor(b, "stretch", "deck B");
    fire(a);
    fire(b);
    const dead = dumpRing().filter((e) => e.ch === "worklet-dead");
    expect(dead).toHaveLength(2);
    expect(dead.map((e) => e.where)).toEqual(["deck A", "deck B"]);
  });

  it("a different kind is different news and speaks for itself", () => {
    const a = fakeNode();
    const b = fakeNode();
    watchProcessor(a, "comp");
    watchProcessor(b, "stretch");
    fire(a);
    fire(b);
    expect(console.error).toHaveBeenCalledTimes(2);
  });

  it("names the kind in what it prints, or the line cannot be acted on", () => {
    const n = fakeNode();
    watchProcessor(n, "reverbfdn");
    fire(n);
    expect(String((console.error as unknown as { mock: { calls: string[][] } }).mock.calls[0][0])).toContain("reverbfdn");
  });
});

describe("every worklet node is watched", () => {
  // The drift guard. An eleventh AudioWorkletNode added without a watch is a silent failure with no
  // witness — exactly the state this whole change exists to leave behind. Counting is enough here:
  // the two numbers are small, they sit in one directory, and a mismatch names the files.
  //
  // ★ AND .tsx TOO. The directory was widened before the EXTENSION was — `/\.ts$/` does not match
  // "Foo.tsx", so every component file was still outside the population. Same closed-world claim,
  // one axis over: nothing in src/ builds a worklet from a component TODAY (checked, zero matches),
  // which is exactly the argument for including them before something does.
  //
  // ★ IT SCANS ALL OF src/, NOT THIS DIRECTORY. The first version said the nodes "sit in one
  // directory", which was TRUE — verified, all ten are under src/htl/audio — and it is a
  // closed-world claim about siblings, the exact sentence a reader uses to decide where to stop
  // looking. A worklet built anywhere else would be unwatched AND uncounted, and the guard would
  // stay green while the roster it guards was wrong. Widening it changes nothing today, which is
  // the point: it costs one walk and it cannot go stale by someone putting a file elsewhere.
  // The walk itself now lives in src/htl/testing/sourceScan — recursive, .ts AND .tsx, tests
  // excluded. This file had two of the three narrowings that produced it (mine by directory, then
  // by extension), so it has no business keeping a fourth private copy of the same loop.
  const counts = sourceFiles(join(__dirname, "..", ".."))
    .filter((f) => !f.path.endsWith("workletWatch.ts"))
    .map((f) => ({
      f: f.path,
      nodes: (f.src.match(/new AudioWorkletNode\(/g) ?? []).length,
      watched: (f.src.match(/watchProcessor\(/g) ?? []).length,
    }))
    .filter((c) => c.nodes || c.watched);

  it("found worklet nodes to check (vacuity guard)", () => {
    expect(counts.reduce((a, c) => a + c.nodes, 0)).toBeGreaterThanOrEqual(10);
  });

  it("every file constructing one also watches the same number", () => {
    const off = counts.filter((c) => c.nodes !== c.watched).map((c) => `${c.f}: ${c.nodes} nodes, ${c.watched} watched`);
    expect(off).toEqual([]);
  });
});

describe("a dead processor is REPORTED, never touched", () => {
  // ★ THE DELIBERATE NON-RECOVERY, PINNED — because it is a REASON that lived only in a comment,
  // and a reason in a comment is one well-meaning edit from being reversed with nothing noticing.
  // The comment says it: "It REPORTS and does not repair. A dead processor cannot be revived, and
  // rebuilding the master bus mid-performance on an automatic trigger is a bigger decision than an
  // observability fix should make."
  //
  // That is exactly the kind of restraint a later reader undoes in good faith — "why don't we just
  // rebuild it?" — so the test asserts the SHAPE of the restraint rather than its wording: the only
  // thing this module may ever do to a node is attach one handler. Any disconnect, reconnect,
  // rebuild or parameter touch would show up here as an extra property access.
  //
  // (Taken from Metron's own flag that the worklet watch's reasons live in comments while its
  // behaviours live in tests. His file; his rationale; the pin is the part that was missing.)
  it("attaching and firing touches exactly one property on the node — onprocessorerror", () => {
    const touched: string[] = [];
    const target = { onprocessorerror: null } as ProcessorErrorTarget;
    const node = new Proxy(target, {
      get(t, p, r) {
        touched.push(`get:${String(p)}`);
        return Reflect.get(t, p, r);
      },
      set(t, p, v, r) {
        touched.push(`set:${String(p)}`);
        return Reflect.set(t, p, v, r);
      },
    });
    watchProcessor(node, "comp", "the master brickwall");
    target.onprocessorerror?.(new Event("error") as ErrorEvent);
    const props = [...new Set(touched.map((s) => s.split(":")[1]))];
    expect(props).toEqual(["onprocessorerror"]);
  });

  it("the handler does not throw — a dying processor must not take its caller with it", () => {
    // onprocessorerror is dispatched by the audio thread's plumbing. A throw here would surface as
    // an unhandled rejection in whatever is pumping it, turning one silent failure into two.
    const n = { onprocessorerror: null } as ProcessorErrorTarget;
    watchProcessor(n, "stretch", "deck A");
    expect(() => n.onprocessorerror?.(new Event("error") as ErrorEvent)).not.toThrow();
  });
});
