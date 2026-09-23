import { describe, expect, it, beforeEach, vi, afterEach } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
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
  const ROOT = join(__dirname, "..", "..");
  const walk = (d: string): string[] =>
    readdirSync(d, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(d, e.name)) : /\.tsx?$/.test(e.name) && !/\.test\./.test(e.name) ? [join(d, e.name)] : [],
    );
  const counts = walk(ROOT)
    .filter((f) => !f.endsWith("workletWatch.ts"))
    .map((f) => {
      const src = readFileSync(f, "utf8");
      return {
        f: f.slice(ROOT.length + 1),
        nodes: (src.match(/new AudioWorkletNode\(/g) ?? []).length,
        watched: (src.match(/watchProcessor\(/g) ?? []).length,
      };
    })
    .filter((c) => c.nodes || c.watched);

  it("found worklet nodes to check (vacuity guard)", () => {
    expect(counts.reduce((a, c) => a + c.nodes, 0)).toBeGreaterThanOrEqual(10);
  });

  it("every file constructing one also watches the same number", () => {
    const off = counts.filter((c) => c.nodes !== c.watched).map((c) => `${c.f}: ${c.nodes} nodes, ${c.watched} watched`);
    expect(off).toEqual([]);
  });
});
