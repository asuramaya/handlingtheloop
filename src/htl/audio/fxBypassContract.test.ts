import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

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
const DIR = join(__dirname);

describe("the FxDevice bypass contract", () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith(".ts") && !f.includes(".test."));

  it("scans the real device files (a zero here would make this vacuous)", () => {
    expect(files.length).toBeGreaterThan(8);
  });

  it("no device narrows setBypass to a single parameter", () => {
    const narrowed: string[] = [];
    for (const f of files) {
      const src = readFileSync(join(DIR, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
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
