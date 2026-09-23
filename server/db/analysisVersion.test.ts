import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { THIRD_PARTY_ANALYSIS_VERSION } from "./analysis";
import { sourceFiles, stripComments } from "../../src/htl/testing/sourceScan";

// THE DON'T-DOWNGRADE GUARD IS `excluded.version >= track_analysis.version`, SO A TIE OVERWRITES.
// `version` is an OPTIONAL parameter of upsertAnalysis, so omitting it is silent, legal, and lands
// on the schema default — which ties with every row that also took the default. That omission is
// what the /api/features lane shipped with, and what it cost is measured in the constant's comment.
//
// So the assertion worth having is not about the number. It is that NO CALLER OMITS IT: the next
// contributor lane gets the same tie for the same reason, and nothing in the type system says so.

const root = fileURLToPath(new URL("../..", import.meta.url));

describe("analysis contribution versions", () => {
  test("the third-party lane sits BELOW the schema default, read from the migration not from memory", () => {
    const sql = readFileSync(`${root}migrations/0004_analysis.sql`, "utf8");
    const m = sql.match(/version\s+INTEGER\s+NOT NULL\s+DEFAULT\s+(\d+)/i);
    expect(m, "migration 0004 no longer declares a default for track_analysis.version").not.toBeNull();
    const schemaDefault = Number(m![1]);
    // Strictly below: at the default it TIES, and `>=` makes a tie an overwrite.
    expect(THIRD_PARTY_ANALYSIS_VERSION).toBeLessThan(schemaDefault);
  });

  test("every upsertAnalysis call site names a version — an omitted one silently ties", () => {
    const offenders: string[] = [];
    for (const f of [...sourceFiles(`${root}worker`), ...sourceFiles(`${root}server`), ...sourceFiles(`${root}src`)]) {
      const src = stripComments(f.src);
      // Each call's argument text, up to the matching close of the object literal it is given.
      // `function upsertAnalysis(` is the DECLARATION, whose parameter object also has no
      // `version:` key at the top level — the scan found it on the first run, which is the
      // population check doing its job rather than a nuisance.
      for (const m of src.matchAll(/(?<!function\s)\bupsertAnalysis\s*\(/g)) {
        const open = src.indexOf("{", m.index! + m[0].length);
        if (open < 0) continue;
        let depth = 0;
        let end = open;
        for (; end < src.length; end++) {
          if (src[end] === "{") depth++;
          else if (src[end] === "}" && --depth === 0) break;
        }
        const args = src.slice(open, end + 1);
        if (!/\bversion\s*:/.test(args)) offenders.push(`${f.path} — upsertAnalysis({...}) with no \`version:\``);
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});
