import { describe, test, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";

// ★ AN ANALYSER IS A PATH, AND CUTTING IT HAS A DIRECTION.
//
// A live AudioContext keeps the ENTIRE upstream of an AnalyserNode scheduled even when the analyser
// itself reaches nothing. BaseFxDevice's activation gate cut `wet → output` and stopped, because a
// comment said that was the only edge out of the wet bus. It was not: `wet → wetMeter` was minted in
// the constructor and never cut, so every bypassed comp and reverb ran its worklet at ~95% of active
// cost for two years (Deckard, 5b90ca3; three independent measurements reconciled).
//
// ★ AND THE DIRECTION IS THE TRAP. An AnalyserNode HAS NO OUTPUTS, so `analyser.disconnect()` is a
// NO-OP — the edge exists only from the source side and can only be severed as
// `source.disconnect(analyser)`. I tested that hypothesis twice with the no-op version, saw no
// change, and published "the meter is ruled out" both times. The hypothesis was right; the call did
// nothing. This test exists so that mistake is mechanical to catch instead of costing two passes.
// ★ STRIP COMMENTS FIRST. The first run of this scan flagged Fx.ts for `wetMeter.disconnect()` — in
// a COMMENT explaining that the call is a no-op. A scan that reads prose finds the CLAIM instead of
// the code, which is the exact confusion it exists to end; the ORDER BY scan in server/db learned
// this days ago and I rebuilt the mistake rather than reading its neighbour.
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/([^:])\/\/.*$/gm, "$1");
const ROOTS = ["../../htl/audio", "../../components"];
const files: { path: string; src: string }[] = [];
for (const root of ROOTS) {
  const dir = new URL(`${root}/`, import.meta.url);
  for (const name of readdirSync(dir)) {
    if (!/\.(ts|tsx)$/.test(name) || name.endsWith(".test.ts") || name.endsWith(".test.tsx")) continue;
    const u = new URL(name, dir);
    if (statSync(u).isDirectory()) continue;
    const label = root === "../../components" ? "src/components" : "src/htl/audio";
    files.push({ path: `${label}/${name}`, src: stripComments(readFileSync(u, "utf8")) });
  }
}

/** Names assigned from createAnalyser() in a file — `this.x = ctx.createAnalyser()` or `const x = …`. */
function analyserNames(src: string): string[] {
  const out = new Set<string>();
  for (const m of src.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*[\w.]*\.createAnalyser\(\)/g)) out.add(m[1]);
  for (const m of src.matchAll(/this\.(\w+)\s*=\s*[\w.]*\.createAnalyser\(\)/g)) out.add(m[1]);
  return [...out];
}

describe("every AnalyserNode edge is cut from the SOURCE side, never from the analyser", () => {
  test("the scan found analysers to check (vacuity guard)", () => {
    const n = files.reduce((k, f) => k + analyserNames(f.src).length, 0);
    expect(n).toBeGreaterThanOrEqual(10);
  });

  // ★ THE ONE THAT CATCHES MY MISTAKE. `x.disconnect()` where x is an analyser severs nothing, and
  // it reads exactly like a cleanup — which is what makes it survive review.
  test("nobody calls disconnect() ON an analyser — it has no outputs, so it does nothing", () => {
    const offenders: string[] = [];
    for (const f of files) {
      for (const name of analyserNames(f.src)) {
        const bare = new RegExp(`(?:this\\.)?${name}\\.disconnect\\(\\s*\\)`);
        if (bare.test(f.src)) offenders.push(`${f.path}: ${name}.disconnect() is a NO-OP — use source.disconnect(${name})`);
      }
    }
    expect(offenders).toEqual([]);
  });

  // The control: the scan must be able to SEE a source-side cut, or the rule above is the only
  // thing it enforces and "everyone cuts correctly" would be vacuous rather than true.
  test("and the source-side form is present where a tap is torn down", () => {
    const cutting = files.filter((f) => analyserNames(f.src).some((n) => new RegExp(`\\.disconnect\\(\\s*(?:this\\.)?${n}\\s*\\)`).test(f.src)));
    expect(cutting.length).toBeGreaterThanOrEqual(5);
  });
});
