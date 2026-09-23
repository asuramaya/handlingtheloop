import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { sourceFiles, stripComments } from "../testing/sourceScan";

// A LIMIT DECLARED ON BOTH SIDES OF THE WIRE IS TWO VALUES OBLIGED TO AGREE.
//
// The client refuses an oversized upload so the user gets a message instead of a 413; the server
// refuses it again because a client can lie. Both are right. What is wrong is that each side
// declares its own copy of the number, so nothing holds them together — the same defect as the
// `hangs`/`gen` pair, and as a test restating a module's default instead of asking for it by name.
//
// THE TWO FAILURES ARE NOT SYMMETRIC, which is why this is worth a guard rather than a comment:
//   • client raised, server not → the client accepts the file and the upload fails at the server.
//     The user picked something the app said was fine and watched it break.
//   • server raised, client not → the client refuses files the server would have taken. Silent, and
//     the product is quietly smaller than it is configured to be.
// Neither shows up in any behavioural test, because each side is self-consistent.
//
// This scans for the CLASS rather than pinning today's three, so a fourth duplicated limit is
// caught the day it is written rather than the day the two copies diverge.

const ROOT = join(__dirname, "..", "..");         // src/
const SERVER = join(__dirname, "..", "..", "..", "server");

/** `export const NAME = <initialiser>;` on one line — the shape a shared limit is written in. */
const DECLS = /^export const ([A-Z][A-Z0-9_]*)\s*(?::[^=]+)?=\s*([^;]+);/gm;

function constantsIn(files: { path: string; src: string }[]): Map<string, { value: string; where: string }> {
  const out = new Map<string, { value: string; where: string }>();
  for (const { path, src } of files) {
    for (const m of stripComments(src).matchAll(DECLS)) {
      if (!out.has(m[1])) out.set(m[1], { value: m[2].trim(), where: path });
    }
  }
  return out;
}

describe("limits declared on both sides of the wire", () => {
  const client = constantsIn(sourceFiles(ROOT));
  const server = constantsIn(sourceFiles(SERVER));
  const shared = [...client.keys()].filter((k) => server.has(k));

  it("found shared limits to check (vacuity guard — a zero here would make the rule below empty)", () => {
    // If this ever drops to zero, either the duplication was fixed properly (good — delete this
    // file) or the scan stopped seeing one of the two trees (bad, and silent without this).
    expect(shared.length).toBeGreaterThanOrEqual(3);
  });

  it("every shared limit has the SAME initialiser on both sides", () => {
    const off = shared
      .filter((k) => client.get(k)!.value !== server.get(k)!.value)
      .map((k) => `${k}: client ${client.get(k)!.value} (${client.get(k)!.where}) vs server ${server.get(k)!.value} (${server.get(k)!.where})`);
    expect(
      off,
      `these limits are declared on both sides of the wire and no longer agree — raising one without the other either breaks an upload the client promised would work, or silently shrinks the product:\n${off.join("\n")}`,
    ).toEqual([]);
  });
});
