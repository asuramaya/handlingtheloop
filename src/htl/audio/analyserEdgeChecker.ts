// WHICH `x.disconnect()` CALLS ARE ON AN AnalyserNode — asked of the type checker, not of the text.
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
