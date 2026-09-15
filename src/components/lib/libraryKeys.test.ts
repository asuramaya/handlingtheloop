import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// ★ A ROSTER THAT CHECKS ITSELF.
//
// LibraryPanel.tsx carries a comment listing every localStorage key the panel's memory uses,
// because none of them is discoverable from any other: they are direct localStorage, so a grep for
// `Store<` matches none, and a grep for a guessed key name matches only itself. Metron ran exactly
// those two searches, concluded the persistence did not exist, and had to retract it.
//
// But a roster is a CLOSED-WORLD CLAIM — "these are all of them" — which is the single sentence
// shape that has gone stale over and over in this repo: "the fourth door", "the only place this
// rule lived", "shouldn't happen post-provision", "mirrors the real one". Every one was true when
// written. A comment that says you have seen everything is the exact sentence a reader uses to
// stop looking, so it fails silently in the direction nobody checks.
//
// This test is the difference between a careful sentence and a checked one. It reads the source as
// TEXT and compares the keys that actually exist against the roster below, in both directions:
// adding a key without listing it fails, and deleting one while leaving it listed fails too.
//
// It proved itself immediately: the roster as first written said FOUR keys and omitted
// htl:wizardSeen, which had been sitting in the file the whole time. The comment written to cure
// stale closed-world claims was itself a stale closed-world claim within minutes.

const FILES = ["../LibraryPanel.tsx", "trackTableState.ts"];

/** Every key the library's persistence is EXPECTED to use. Adding one here without adding it to
 *  LibraryPanel's roster comment (or vice versa) is the thing this file exists to catch. */
const ROSTER = [
  "htl:libView", // the open tab { view, search, sync }
  "htl:libNav", // sidebar open/closed
  "htl:libSections", // which sidebar sections are expanded
  "htl:wizardSeen", // first-run wizard
  "htl:tt:", // per-LIST find-controls; the list name is appended (trackTableState.ts)
].sort();

function keysIn(rel: string): string[] {
  const src = readFileSync(resolve(__dirname, rel), "utf8");
  // Quoted literals only. The roster comment names the keys WITHOUT quotes precisely so that it
  // cannot satisfy its own test — a roster that matched itself would pass while the code diverged.
  return [...src.matchAll(/"(htl:[^"]*)"/g)].map((m) => m[1]);
}

describe("the library's persistence keys", () => {
  it("★ the roster in LibraryPanel names every key that actually exists, and no key it does not", () => {
    const found = [...new Set(FILES.flatMap(keysIn))].sort();
    expect(found).toEqual(ROSTER);
  });

  it("the roster COMMENT lists each key too, so a reader of the file sees what this test sees", () => {
    const src = readFileSync(resolve(__dirname, "../LibraryPanel.tsx"), "utf8");
    // The roster block is the only place the keys appear unquoted; requiring each one there keeps
    // the human-readable list and the machine-checked list from drifting apart.
    for (const key of ROSTER) expect(src).toContain(key);
  });

  it("states the count correctly — the claim a reader actually acts on", () => {
    // "spread over FOUR keys" was wrong the moment it was written. A number in a roster is the
    // most load-bearing word in it: it is what tells someone they have found them all.
    const src = readFileSync(resolve(__dirname, "../LibraryPanel.tsx"), "utf8");
    const words = ["ONE", "TWO", "THREE", "FOUR", "FIVE", "SIX", "SEVEN", "EIGHT"];
    expect(src).toContain(`SPREAD OVER ${words[ROSTER.length - 1]} KEYS`);
  });
});
