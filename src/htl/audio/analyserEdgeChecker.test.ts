import { describe, test, expect } from "vitest";
import ts from "typescript";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bareAnalyserDisconnects } from "./analyserEdgeChecker";

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
