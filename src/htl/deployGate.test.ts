import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// THE LAST THING THAT RUNS BEFORE SHIPPING HAD A HAND-LISTED ROSTER IN IT.
//
// deploy.sh's gate ran `tsc -p tsconfig.node.json` and its comment named the set: the src
// typecheck plus the worker project's. Then 747b4a0 added a third project for the fxlab/joglab
// harnesses — which had been outside every tsconfig, which is how a defect in the product hid
// there (89902a4) — and the gate did not grow. Nothing failed. A roster in a gate fails silently,
// in the direction nobody checks, at the moment nobody is looking.
//
// The gate now calls `pnpm typecheck`, the single source of truth. This keeps it that way: if
// someone re-inlines a project list into the deploy script, the set can drift again, and this is
// the cheapest place to say so.

const ROOT = join(__dirname, "..", "..");
const deploy = readFileSync(join(ROOT, "deploy.sh"), "utf8");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
const gate = deploy.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");

describe("the deploy gate typechecks everything the repo typechecks", () => {
  it("calls the single source of truth, not a hand-listed set of projects", () => {
    expect(gate).toMatch(/\bpnpm typecheck\b/);
  });

  it("does not name a tsconfig project directly — that is the roster that went stale", () => {
    const inlined = [...gate.matchAll(/tsc\s+-p\s+(\S+)/g)].map((m) => m[1]);
    expect(inlined).toEqual([]);
  });

  it("CONTROL: the script was actually read and the gate is in it", () => {
    expect(deploy).toContain("pre-deploy gate");
    expect(gate).toMatch(/\bpnpm test\b/);
  });

  it("the typecheck script really does cover more than one project (vacuity guard)", () => {
    const tc = pkg.scripts.typecheck ?? "";
    expect(tc.match(/tsc\b/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });
});
