// AUDIO-GRAPH FACTS A TEXT SCAN CANNOT REACH — asked of the type checker.
//
// Two queries, one program build (~2.2s), because vitest isolates files into separate workers and
// paying that twice for the same program is waste. Both are here for the same stated reason: the
// fact each needs is "what type is this expression" or "which symbol is this", which is the one
// question a regex can only ever approximate (practice 71cc0ba4 and its boundary).
//
// ── 1. WHICH `x.disconnect()` CALLS ARE ON AN AnalyserNode ──────────────────────────────────────
//
// ★ AN ANALYSER HAS NO OUTPUTS, SO `analyser.disconnect()` SEVERS NOTHING. It reads exactly like a
// cleanup, which is what let it survive review in this repo once already: the edge is only cut as
// `source.disconnect(analyser)`. The scan that enforces that rule has to know which expressions ARE
// analysers, and analyserEdgeScan.test.ts answered by matching three text shapes — a const/let/var
// assigned from createAnalyser(), a `this.x =` assignment, and anything annotated `: AnalyserNode`.
//
// ★ MEASURED AGAINST ITS OWN BODY, IT IS BLIND TO FOUR FORMS, and the first is the idiomatic one:
//
//     private meter = ctx.createAnalyser();      MISSED  (class field, type inferred)
//     readonly meter = ctx.createAnalyser();     MISSED
//     this.meters = [ctx.createAnalyser(), …];   MISSED  (held in an array)
//     const meter = makeMeter();                 MISSED  (returned by a factory)
//
// None exists in the tree today, which is the moment to close it rather than the moment to discover
// it. And unlike `extends` in deckSurfaceBound — where a one-line ban closed the hole exactly —
// there is no ban to write here: `private meter = ctx.createAnalyser()` is how a person would
// naturally write it, and forbidding the natural form to keep a regex working is the wrong trade.
//
// So this is the case where the expensive instrument is the one to SHIP, not just to ask. Practice
// 71cc0ba4 says use the checker to learn the fact and encode it cheaply where you can; the second
// half does not apply when the fact IS "what type is this expression", because that is the one
// question a text scan can only ever approximate. Building the program costs ~2.2s per run.
import ts from "typescript";

export interface BareDisconnect {
  file: string;
  line: number;
  text: string;
}

/** Every `<expr>.disconnect()` with NO arguments whose receiver's type is AnalyserNode.
 *  `roots` are the tsconfig file list; `filter` picks which files to judge. */
export function bareAnalyserDisconnects(program: ts.Program, keep: (file: string) => boolean): BareDisconnect[] {
  const checker = program.getTypeChecker();
  const out: BareDisconnect[] = [];

  /** The DOM's AnalyserNode interface, by name on its own declaration — so a hand-rolled type that
   *  merely has `getByteFrequencyData` is not mistaken for one, and a subtype of it still counts. */
  const isAnalyser = (t: ts.Type): boolean => {
    const sym = t.getSymbol();
    if (!sym) return false;
    if (sym.getName() === "AnalyserNode") return true;
    // A class extending it, or an alias resolving to it.
    return checker.getBaseTypes?.(t as ts.InterfaceType)?.some((b) => b.getSymbol()?.getName() === "AnalyserNode") ?? false;
  };

  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile) continue;
    const file = sf.fileName.replace(/\\/g, "/");
    if (!keep(file)) continue;

    const visit = (n: ts.Node): void => {
      // `<recv>.disconnect()` — a call, with the property access as its callee, and zero arguments.
      // An argument means `source.disconnect(analyser)`, which is the CORRECT form and never a hit.
      if (ts.isCallExpression(n) && n.arguments.length === 0 && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "disconnect") {
        const recv = n.expression.expression;
        let t: ts.Type | undefined;
        try {
          t = checker.getTypeAtLocation(recv);
        } catch {
          t = undefined;
        }
        // A union (AnalyserNode | null) counts: the call still reaches the analyser.
        const parts = t ? (t.isUnion() ? t.types : [t]) : [];
        if (parts.some(isAnalyser)) {
          out.push({ file, line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1, text: recv.getText() });
        }
      }
      ts.forEachChild(n, visit);
    };
    ts.forEachChild(sf, visit);
  }
  return out;
}


/** A worklet node constructed in a file, and whether the symbol it landed in is ever watched. */
export interface WorkletPairing {
  file: string;
  line: number;
  target: string;
}

/** Every `new AudioWorkletNode(...)` whose assignment target is never passed to `watchProcessor`.
 *
 *  ★ A COUNT IS NOT A PAIRING, and workletWatch.test.ts checked a count: per file, the number of
 *  `new AudioWorkletNode(` occurrences must equal the number of `watchProcessor(` occurrences.
 *  Planted an UNWATCHED node beside a second `watchProcessor` call on a node already watched —
 *  counts stayed equal, tsc silent, all nine tests green. The thing that guard exists to prevent is
 *  a processor nobody is listening to, and a processor that throws goes PERMANENTLY SILENT,
 *  reporting only through `onprocessorerror`. So the count could be right while the whole point was
 *  lost.
 *
 *  Matched by SYMBOL, not by name: `const n = new AudioWorkletNode(...)` and `watchProcessor(n, …)`
 *  are the same symbol even where two functions both call their local `n`, and a node stored as
 *  `this.node` is the same symbol at both ends. That is the part a text scan cannot do at all.
 *
 *  A node constructed and passed straight into something else without landing in a variable has no
 *  target symbol; it is reported, because an unnamed worklet cannot be watched either. */
export function unwatchedWorklets(program: ts.Program, keep: (file: string) => boolean): WorkletPairing[] {
  return workletScan(program, keep).unwatched;
}

/** Every worklet construction found, watched or not — so a vacuity guard can prove the query still
 *  SEES them. `unwatchedWorklets` returning [] is the same answer whether every node is watched or
 *  the constructor stopped resolving, and those are opposite facts. */
export function workletConstructions(program: ts.Program, keep: (file: string) => boolean): WorkletPairing[] {
  return workletScan(program, keep).all;
}

function workletScan(program: ts.Program, keep: (file: string) => boolean): { all: WorkletPairing[]; unwatched: WorkletPairing[] } {
  const checker = program.getTypeChecker();
  const watched = new Set<ts.Symbol>();
  const made: { sym: ts.Symbol | undefined; file: string; line: number; target: string }[] = [];

  // ★ THE TYPE OF THE `new` EXPRESSION, NOT OF THE CALLEE. My first version asked
  // getTypeAtLocation(n.expression) — the type of the identifier `AudioWorkletNode`, which is the
  // CONSTRUCTOR ({ prototype, new(): … }), not an AudioWorkletNode. It matched nothing, so
  // `unwatchedWorklets` returned [] and the rule read as "every node is watched". The vacuity guard
  // caught it on its first run, which is the entire reason that guard counts CONSTRUCTIONS rather
  // than trusting an empty offender list.
  const isWorkletNode = (n: ts.NewExpression): boolean => {
    const t = checker.getTypeAtLocation(n);
    const sym = t.getSymbol();
    if (sym?.getName() === "AudioWorkletNode") return true;
    // A subclass counts: `class Scratch extends AudioWorkletNode` is still a worklet node.
    const decl = sym?.declarations?.[0];
    return !!decl && ts.isClassDeclaration(decl) && !!decl.heritageClauses?.some((h) => h.types.some((x) => x.expression.getText() === "AudioWorkletNode"));
  };

  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile) continue;
    const file = sf.fileName.replace(/\\/g, "/");
    if (!keep(file)) continue;

    const visit = (n: ts.Node): void => {
      // watchProcessor(<target>, …) — record the symbol of whatever is being watched.
      if (ts.isCallExpression(n) && n.expression.getText().endsWith("watchProcessor") && n.arguments.length) {
        const s = checker.getSymbolAtLocation(n.arguments[0]);
        if (s) watched.add(s);
      }
      if (ts.isNewExpression(n) && isWorkletNode(n)) {
        // The symbol this node lands in: `const n = new …` or `this.node = new …`.
        let sym: ts.Symbol | undefined;
        let target = "<unassigned>";
        const p = n.parent;
        if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) {
          sym = checker.getSymbolAtLocation(p.name);
          target = p.name.text;
        } else if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
          sym = checker.getSymbolAtLocation(p.left);
          target = p.left.getText();
        } else if (ts.isPropertyDeclaration(p) && ts.isIdentifier(p.name)) {
          sym = checker.getSymbolAtLocation(p.name);
          target = p.name.text;
        }
        made.push({ sym, file, line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1, target });
      }
      ts.forEachChild(n, visit);
    };
    ts.forEachChild(sf, visit);
  }
  const strip = ({ file, line, target }: { file: string; line: number; target: string }) => ({ file, line, target });
  return { all: made.map(strip), unwatched: made.filter((m) => !m.sym || !watched.has(m.sym)).map(strip) };
}
