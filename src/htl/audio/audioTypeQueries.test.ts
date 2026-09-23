import { describe, test, expect } from "vitest";
import ts from "typescript";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bareAnalyserDisconnects, unwatchedWorklets, workletConstructions } from "./audioTypeQueries";

// ★ THE SAME RULE analyserEdgeScan.test.ts ENFORCES, ASKED OF THE CHECKER INSTEAD OF THE TEXT.
// That file's three regexes are blind to four ways of holding an analyser — a class field with an
// inferred type (the idiomatic form), a readonly field, one inside an array, one returned by a
// factory. See analyserEdgeChecker.ts for why the answer here is to ship the checker rather than
// ban the forms, which is the opposite call from `extends` in deckSurfaceBound and for a stated
// reason: there the ban was exact, here the natural way to write it is the thing that would be
// banned.
//
// The text scan stays. It is fast, it runs on every file including scripts/, and two instruments
// that disagree are the cheapest bug detector available — which is the standing practice this whole
// session keeps re-earning.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function program(): ts.Program {
  const cfgPath = ts.findConfigFile(root, ts.sys.fileExists, "tsconfig.json");
  if (!cfgPath) throw new Error("no tsconfig.json at the repo root");
  const cfg = ts.parseJsonConfigFileContent(ts.readConfigFile(cfgPath, ts.sys.readFile).config, ts.sys, dirname(cfgPath));
  return ts.createProgram(cfg.fileNames, cfg.options);
}

const prog = program();
const inSrc = (f: string) => f.includes("/src/") && !/\.test\.tsx?$/.test(f);

describe("no AnalyserNode is disconnected from the analyser side", () => {
  // ★ VACUITY FIRST, and it is a different vacuity from the text scan's. That one counts analysers
  // it can NAME. This one must prove the checker is resolving DOM types at all — if the lib types
  // failed to load, every receiver would be `any`, nothing would match AnalyserNode, and the rule
  // below would pass by being unable to see anything.
  test("the checker resolves AnalyserNode at all", () => {
    const checker = prog.getTypeChecker();
    let seen = 0;
    for (const sf of prog.getSourceFiles()) {
      if (sf.isDeclarationFile || !inSrc(sf.fileName.replace(/\\/g, "/"))) continue;
      const visit = (n: ts.Node): void => {
        if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "createAnalyser") {
          if (checker.getTypeAtLocation(n).getSymbol()?.getName() === "AnalyserNode") seen++;
        }
        ts.forEachChild(n, visit);
      };
      ts.forEachChild(sf, visit);
    }
    expect(seen, "no createAnalyser() call resolved to AnalyserNode — the DOM lib is not loaded and this suite asserts nothing").toBeGreaterThanOrEqual(5);
  });

  test("★ nobody calls disconnect() ON an analyser — it has no outputs, so it does nothing", () => {
    const hits = bareAnalyserDisconnects(prog, inSrc);
    const named = hits.map((h) => `${h.file.slice(h.file.indexOf("/src/") + 1)}:${h.line} — ${h.text}.disconnect() is a NO-OP; cut it as source.disconnect(${h.text})`);
    expect(named.join("\n")).toBe("");
  });
});

// ★ A COUNT IS NOT A PAIRING. workletWatch.test.ts asserts, per file, that `new AudioWorkletNode(`
// occurrences equal `watchProcessor(` occurrences. Planted an UNWATCHED node beside a duplicate
// watch of a node already watched: counts stayed equal, tsc silent, all nine of its tests green.
//
// It matters more than the analyser rule. An AudioWorkletProcessor that throws goes PERMANENTLY
// SILENT — measured earlier in this codebase at 10 of 375 blocks, then nothing — and reports only
// through `onprocessorerror`, which is exactly what watchProcessor wires. A count that is right
// while a node goes unwatched loses the whole point of the guard.
//
// The count check STAYS: it is fast, it is per-file, and its failure message names the file. This
// answers the different question — WHICH node, by symbol.
describe("every worklet node is watched, matched by symbol rather than counted", () => {
  test("the query finds worklet constructions at all (vacuity guard)", () => {
    // ★ AN EMPTY `unwatchedWorklets` IS THE SAME ANSWER FOR TWO OPPOSITE FACTS — every node watched,
    // or the constructor no longer resolving after a lib change or a rename. Only the total
    // separates them, which is why `workletConstructions` exists at all.
    const all = workletConstructions(prog, inSrc);
    expect(all.length, "no `new AudioWorkletNode` resolved — this suite asserts nothing").toBeGreaterThanOrEqual(10);
  });

  test("★ no worklet node is left unwatched", () => {
    const hits = unwatchedWorklets(prog, inSrc);
    const named = hits.map((h) => `${h.file.slice(h.file.indexOf("/src/") + 1)}:${h.line} — \`${h.target}\` is never passed to watchProcessor; a processor that throws goes permanently silent`);
    expect(named.join("\n")).toBe("");
  });
});
