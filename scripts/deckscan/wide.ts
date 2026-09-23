// WHICH MODULES ACTUALLY REACH FOR THE WIDE `Deck` — asked of the type checker, not of the text.
//
// ★ THIS IS THE POPULATION src/htl/audio/deckSurfaceBound.test.ts SAYS IT CANNOT DERIVE, and its
// reason for not deriving it was right: matching `.<writerName>(` against Deck's writers returns 62
// modules and most are false, because `play`, `stop` and `set*` are also methods on Eq3, NoiseFx and
// LoopEngine, and a bare method name does not say what the RECEIVER was.
//
// The receiver's type is exactly what a compiler knows and a regex never will. So this asks it.
// TypeScript is already a dependency and already parses this program for every gate; borrowing its
// checker costs one script and no new tooling.
//
// ★ WHAT IT IS FOR, and it is NOT a guard. The bound-surface test protects modules that CLAIM a
// narrow surface. It cannot find one that should have claimed it and did not. This prints that
// list — the modules holding the whole 271-member Deck — so a person can look down it and decide.
// It deliberately asserts nothing: a number that moves for good reasons (a new component that
// legitimately drives a deck) must not fail a gate, or the gate gets an exemption list and we are
// back where this whole line of work started.
//
//   npx tsx scripts/deckscan/wide.ts

import ts from "typescript";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const cfgPath = ts.findConfigFile(root, ts.sys.fileExists, "tsconfig.json");
if (!cfgPath) throw new Error("no tsconfig.json");
const cfg = ts.parseJsonConfigFileContent(ts.readConfigFile(cfgPath, ts.sys.readFile).config, ts.sys, dirname(cfgPath));
const program = ts.createProgram(cfg.fileNames, cfg.options);
const checker = program.getTypeChecker();

/** Is this type the Deck class itself (not DeckId, not a narrowed interface that structurally
 *  matches it)? Identity on the declaration, so a bounded surface never counts as the wide one
 *  however many members it happens to share. */
function isWideDeck(t: ts.Type): boolean {
  const sym = t.getSymbol();
  if (!sym || sym.getName() !== "Deck") return false;
  return (sym.declarations ?? []).some(
    (d) => ts.isClassDeclaration(d) && d.getSourceFile().fileName.replace(/\\/g, "/").endsWith("src/htl/audio/Deck.ts"),
  );
}

const hits = new Map<string, { reads: number; calls: number; members: Set<string> }>();

for (const sf of program.getSourceFiles()) {
  if (sf.isDeclarationFile) continue;
  const file = relative(root, sf.fileName).replace(/\\/g, "/");
  if (!file.startsWith("src/") || /\.test\.tsx?$/.test(file) || file.endsWith("src/htl/audio/Deck.ts")) continue;

  const visit = (n: ts.Node): void => {
    if (ts.isPropertyAccessExpression(n)) {
      let t: ts.Type | undefined;
      try {
        t = checker.getTypeAtLocation(n.expression);
      } catch {
        t = undefined;
      }
      // A union (Deck | null) counts if any constituent is the class — the call still reaches it.
      const parts = t ? (t.isUnion() ? t.types : [t]) : [];
      if (parts.some(isWideDeck)) {
        const e = hits.get(file) ?? { reads: 0, calls: 0, members: new Set<string>() };
        const called = ts.isCallExpression(n.parent) && n.parent.expression === n;
        if (called) e.calls++;
        else e.reads++;
        e.members.add(n.name.text);
        hits.set(file, e);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
}

const rows = [...hits.entries()].sort((a, b) => b[1].calls + b[1].reads - (a[1].calls + a[1].reads));
const totalTouches = rows.reduce((s, [, e]) => s + e.calls + e.reads, 0);

console.log(`\n  MODULES HOLDING THE WIDE Deck — asked of the type checker (${rows.length} modules, ${totalTouches} accesses)\n`);
console.log("  calls  reads  distinct  module");
for (const [file, e] of rows) {
  console.log(`  ${String(e.calls).padStart(5)}  ${String(e.reads).padStart(5)}  ${String(e.members.size).padStart(8)}  ${file}`);
}
console.log(
  "\n  A module here is not doing anything wrong — most of these legitimately drive a deck. The list\n" +
    "  is the candidate set for a narrowed surface, which deckSurfaceBound.test.ts can only protect\n" +
    "  AFTER someone declares one. Nothing here is asserted: a count that moves for good reasons must\n" +
    "  not fail a gate, or the gate acquires an exemption list and becomes the roster we removed.\n",
);
