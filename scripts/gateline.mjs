#!/usr/bin/env node
// PRINT THE GATE LINE — never type it.
//
// WHY THIS EXISTS. Three numbers I published in one session were wrong, and all three were
// hand-arithmetic on a figure a tool had already reported correctly: "8 tests" for 7, "1995" for
// 1997, and "182 call sites" for 182 declared writers. The first two were a miscount of a number
// printed on the screen above; the third was worse — the number was right and its UNIT was wrong,
// which no amount of recounting would have caught.
//
// Deckard's distinction, which is the one worth keeping: a habit of writing numbers down instead
// of deriving them is still a habit, and a habit fails silently under time pressure. A script
// whose only job is to count is what converts it into a tool. So this runs the gate and prints
// the exact line to paste — the counts come from vitest's own summary, never from reading it.
//
// It prints the UNIT with every number for the same reason: `182 writers` and `182 call sites`
// are the same integer about different populations, and only one of them was true.
import { execFileSync } from "node:child_process";

const run = (cmd, args) => {
  try {
    return { ok: true, out: execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (e) {
    return { ok: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
};

const tsc = run("pnpm", ["typecheck"]);
const test = run("pnpm", ["test"]);
const build = process.argv.includes("--no-build") ? { ok: null, out: "" } : run("pnpm", ["build"]);

// vitest's own summary lines. Parsed, not read: `Test Files  158 passed (158)` / `Tests  2008 passed (2008)`.
const grab = (label) => {
  const m = test.out.match(new RegExp(`${label}\\s+(?:\\d+ failed \\| )?(\\d+) passed\\s+\\((\\d+)\\)`));
  return m ? { passed: Number(m[1]), total: Number(m[2]) } : null;
};
const files = grab("Test Files");
const cases = grab("Tests");

const fails = [];
if (!tsc.ok) fails.push("typecheck");
if (!test.ok) fails.push("vitest");
if (build.ok === false) fails.push("vite build");
if (!files || !cases) fails.push("could not parse vitest's summary — the gate line is NOT derivable, do not hand-count it");

if (fails.length) {
  console.error(`GATE RED: ${fails.join(", ")}`);
  // ★ THE TAIL IS THE WRONG SLICE, found by planting a failing test rather than by reading this
  // code. vitest's last 25 lines are the duration line and pnpm's own ELIFECYCLE noise; the name
  // of the test that actually failed had already scrolled past. A red gate that does not say what
  // is red sends you to re-run it by hand, which is the thing this script exists to stop.
  const src = test.ok ? tsc.out : test.out;
  const lines = src.split("\n");
  const marked = lines.filter((l) => /FAIL |AssertionError|error TS\d+|Expected|Received|✕/.test(l));
  console.error((marked.length ? marked : lines).slice(0, 40).join("\n"));
  process.exit(1);
}
if (files.passed !== files.total || cases.passed !== cases.total) {
  console.error(`GATE RED: ${files.total - files.passed} test files / ${cases.total - cases.passed} cases not passing`);
  process.exit(1);
}

const parts = ["three tsc projects", `${files.total} test files`, `${cases.total} test cases`];
if (build.ok) parts.push("vite build");
console.log(`Verified: ${parts.join(", ")}.`);
