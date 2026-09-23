import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sourceFiles, stripComments } from "../testing/sourceScan";

// EVERY setBypass OVERRIDE MUST ACCEPT `hard`, BECAUSE TYPESCRIPT WILL NEVER ASK FOR IT.
//
// FxDevice declares `setBypass(on: boolean, hard?: boolean)` and the engine calls it with two
// arguments everywhere it matters: Deck.ts passes `true` on every snapshot restore, room intent and
// pad throw, meaning "land this state now — administrative, not a live toggle". A one-parameter
// override is perfectly legal (a narrower implementation is assignable to a wider signature), so the
// compiler is silent and the flag is simply discarded for that device.
//
// Five of them did: GateFx, Eq3, SaturatorFx, CompFx, CrushFx. ModFx forwarded it. Nothing could have
// told them apart from the outside, and the only reason it surfaced is that the fxlab harness calls a
// CONCRETE CompFx — where the narrow signature is an error — and scripts/ turned out to sit in
// neither tsconfig project, so it had never been typechecked (thread 89b720f4).
//
// This is a source scan rather than a behaviour test on purpose: the defect is in the SIGNATURE, and
// a behaviour test would have to know which devices care about `hard` today. They all have to take
// it; what they do with it is theirs.
// ★ IT SCANS ALL OF src/, NOT THIS DIRECTORY. Every BaseFxDevice subclass lives in src/htl/audio
// today — checked, zero outside — and that is a closed-world claim about its own siblings, which is
// the sentence a reader uses to decide where to stop looking. A device defined anywhere else would
// have been uncounted AND unchecked with this green. Widening costs one walk and nothing else; the
// declaration pattern is anchored at line start, so a CALLER (fxPads.ts, autoMixer.ts) is not a
// match. See sourceScan.ts for why the walk lives in one place.
const ROOT = join(__dirname, "..", "..");

describe("the FxDevice bypass contract", () => {
  const files = sourceFiles(ROOT);

  it("scans the real device files (a zero here would make this vacuous)", () => {
    expect(files.filter((f) => /extends BaseFxDevice/.test(f.src)).length).toBeGreaterThan(5);
  });

  // ★ WHAT THIS CHECKS AND WHAT tsc ALREADY CHECKS — measured, because I nearly built the second
  // half again. The hole I went looking for was an override that TAKES `hard` and then ignores it:
  // the signature is right, the contract is broken, and a Shift-bypass silently becomes a soft one
  // with the tail still ringing. Planted both forms against both instruments:
  //
  //    setBypass(on: boolean)                    tsc SILENT        this scan CAUGHT
  //    setBypass(on, hard) with `hard` unused    tsc TS6133        this scan SILENT
  //
  // They are exactly complementary and neither is redundant. TypeScript permits an override to
  // declare FEWER parameters — arity narrowing is legal and silent, which is the entire reason this
  // file exists. And `noUnusedParameters` (tsconfig.json:21, in the gate) already owns the other
  // half, so widening this scan to check USE would re-implement the compiler badly.
  //
  // `_hard` (Eq3, which has no tail to cut) opts out of TS6133 deliberately. That is the honest
  // form: an underscore is a visible act in a diff, greppable, and it says the parameter is
  // ignored on purpose — which is the whole argument for a weakness you can see over one you
  // cannot.
  it("no device narrows setBypass to a single parameter", () => {
    const narrowed: string[] = [];
    for (const { path: f, src: raw } of files) {
      const src = stripComments(raw);
      for (const m of src.matchAll(/^\s*(?:public\s+)?setBypass\s*\(([^)]*)\)/gm)) {
        const params = m[1].split(",").filter((p) => p.trim().length);
        if (params.length < 2) narrowed.push(`${f}: setBypass(${m[1].trim()})`);
      }
    }
    expect(
      narrowed,
      `these override setBypass without taking \`hard\`, so the engine's second argument is silently dropped:\n${narrowed.join("\n")}`,
    ).toEqual([]);
  });
});
