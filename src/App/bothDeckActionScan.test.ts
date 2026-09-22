import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";

// ★ A PER-DECK GATE ON THE BUTTON IS NOT A GATE ON WHAT THE BUTTON DOES.
//
// The keyboard dispatcher gates correctly — `if (!canDriveDeckRef.current(id)) return;` before it
// runs a handler, so a stage DJ holding deck A cannot aim a key at deck B. Then `tempoRange`'s
// handler ignored the deck it was aimed at and looped over BOTH decks, clamping the other DJ's
// tempo locally and emitting an intent the server refuses (DjRoom.canDrive is deck-scoped, measured
// by Metron in 4cd6456). Silent divergence on a deck this device does not hold — the failure the
// whole listener-guard programme exists to prevent, one role up (thread 71277a23).
//
// So the invariant is not about call sites: it is that any action iterating ("A", "B") and MUTATING
// a deck must ask, per deck, whether this device may drive it. This reads App.tsx and enforces that,
// rather than naming the two functions I happened to find — because the next one will be written by
// someone who never read this comment.
const SRC = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");

/** Every `["A", "B"].forEach(...)` body in App.tsx, with enough context to judge it. */
function bothDeckLoops(src: string): { at: number; body: string }[] {
  const out: { at: number; body: string }[] = [];
  const re = /\(\["A",\s*"B"\][^)]*\)\.forEach\(\((\w+)\)\s*=>\s*\{/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") depth--;
    }
    out.push({ at: src.slice(0, m.index).split("\n").length, body: src.slice(m.index, i) });
  }
  return out;
}

// A loop MUTATES if it calls a deck setter or emits an intent for that deck.
const MUTATES = /\bdeck\.set[A-Z]\w*\(|\bemitRef\.current\(\{|\bemit\(\{/;
// It is SAFE if it asks per deck whether we may drive, or if it only reads.
const ASKS = /canDriveDeckRef\.current\(|canDriveDeck\(/;

// Loops that mutate both decks WITHOUT a per-deck gate, each with why it is allowed to.
const EXEMPT: { line: number; why: string }[] = [];

describe("an action that touches BOTH decks asks per deck whether it may", () => {
  const loops = bothDeckLoops(SRC);

  test("the scan found loops to check (vacuity guard)", () => {
    expect(loops.length).toBeGreaterThanOrEqual(3);
  });

  test("every both-deck loop that mutates a deck gates per deck", () => {
    const offenders = loops
      .filter((l) => MUTATES.test(l.body) && !ASKS.test(l.body))
      .filter((l) => !EXEMPT.some((e) => Math.abs(e.line - l.at) < 3))
      .map((l) => `App.tsx:${l.at} mutates both decks without asking canDriveDeck`);
    expect(offenders).toEqual([]);
  });
});
