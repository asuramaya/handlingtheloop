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

/** Every both-deck loop body in App.tsx, with enough context to judge it.
 *
 *  ★ THE FORMS MATTER AS MUCH AS THE RULE. The first version of this scan matched only
 *  `.forEach((x) => {`, so the two `for (const d of ["A","B"])` loops in the same file were
 *  invisible to it — including one that releases FX pads on both decks and emits for both. An
 *  instrument that states a broad invariant and matches a narrow syntax is a hand-written roster
 *  wearing a regex (Metron, reviewing ae3aed5). Statement forms only: a `.map` returning JSX is a
 *  render, and a render reads.
 */
function bothDeckLoops(src: string): { at: number; body: string }[] {
  const out: { at: number; body: string }[] = [];
  const forms = [
    /\(\["A",\s*"B"\][^)]*\)\.forEach\(\((\w+)\)\s*=>\s*/g, // .forEach, block or expression body
    /for \((?:const|let) (\w+) of \(?\["A",\s*"B"\][^)]*\)?\)\s*/g, // for-of, block or single statement
  ];
  for (const re of forms) {
    for (let m = re.exec(src); m; m = re.exec(src)) {
      const from = m.index + m[0].length;
      let i = from;
      if (src[from] === "{") {
        let depth = 0;
        for (; i < src.length; i++) {
          if (src[i] === "{") depth++;
          else if (src[i] === "}" && --depth === 0) break;
        }
      } else {
        // Expression body / single statement: to the end of the statement at paren depth 0.
        let depth = 0;
        for (; i < src.length; i++) {
          const c = src[i];
          if (c === "(" || c === "{") depth++;
          else if (c === ")" || c === "}") {
            if (depth === 0) break;
            depth--;
          } else if ((c === ";" || c === "\n") && depth === 0) break;
        }
      }
      out.push({ at: src.slice(0, m.index).split("\n").length, body: src.slice(m.index, i + 1) });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

/** Helpers in App.tsx that DRIVE — `(deck: DeckRef, id: DeckId, …)` whose body emits an intent.
 *  Derived from the file, never listed here: a loop calling one of these mutates through it, which
 *  the body's own syntax does not show. fxKeyUp is why this exists. */
function drivingHelpers(src: string): string[] {
  const out: string[] = [];
  const re = /const (\w+) = \(deck: DeckRef, id: DeckId[^)]*\) => \{/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    let depth = 0;
    let i = m.index + m[0].length - 1;
    for (; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}" && --depth === 0) break;
    }
    if (/emitRef\.current\(/.test(src.slice(m.index, i))) out.push(m[1]);
  }
  return out;
}

// ★ WHAT COUNTS AS MUTATING A DECK IS READ FROM THE DECK, not from this file's memory of it.
// The pattern here was `deck.set[A-Z]` — a hand-written list of one NAMING CONVENTION, which is the
// same roster the rest of this scan was built to stop being. It could not see `deck.cuePoint = …`,
// `deck.hotCues = […]`, `deck.seek(…)` or `deck.play()`, all of which are real deck mutations that
// appear in this very file. Metron's rule, after four turns of this between us: EVERY LIST MUST BE
// READ FROM THE ARTIFACT THAT OWNS THE FACT. Deck.ts owns what a deck can do, so Deck.ts is read.
//
// The split is the class's own declaration, not a judgement: a member declared `get` (or `readonly`)
// is a READ; everything else public is treated as a WRITE. That errs toward firing — a plain method
// that only reads will be called a mutation — and the safe direction for a guard is loud, with an
// EXEMPT entry as the place to say otherwise.
function deckWriters(): string[] {
  const src = readFileSync(new URL("../htl/audio/Deck.ts", import.meta.url), "utf8");
  const body = src.slice(src.indexOf("export class Deck"));
  const writers = new Set<string>();
  for (const m of body.matchAll(/^  (?!private |protected |\/\/|\*|\/\*)(readonly\s+|get\s+|set\s+)?([a-zA-Z_]\w*)\s*[(=:]/gm)) {
    const [, kind, name] = m;
    if (name === "constructor") continue;
    if (kind?.startsWith("get") || kind?.startsWith("readonly")) continue; // a read, by the class's own word
    writers.add(name);
  }
  return [...writers];
}

// ★ AND THE RECEIVER IS DERIVED FROM THE LOOP, not from the name `deck`. The writer list is read
// from Deck.ts now, but it was still being matched against one hard-coded variable name — and by
// the test Deckard added himself ("is this the artifact that would CHANGE if the fact changed?") a
// local variable's name is not. `const d = engine.deck(id); d.setTempo(…)` and
// `engine.deck(id).setStems(null)` are both real forms in App.tsx and both sailed past it.
//
// Widening to any receiver would fire on `midi.setFeedback(` in the MIDI-feedback loop, which is not
// a deck at all — a guard that cries wolf gets exemptions written to shut it up, and then it is a
// list again. So the receivers are the identifiers THIS BODY binds to a deck, plus the inline form.
function deckReceivers(body: string): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(/(?:const|let)\s+(\w+)\s*=\s*\w+\.(?:deck\s*\([^)]*\)|deckA|deckB)/g)) out.add(m[1]);
  return [...out];
}

// A loop MUTATES if it touches a deck WRITER, emits an intent, or calls a helper that emits.
const mutates = (body: string, drivers: string[], writers: string[]) => {
  if (/\bemitRef\.current\(\{|\bemit\(\{/.test(body)) return true;
  if (drivers.some((d) => new RegExp(`\\b${d}\\(`).test(body))) return true;
  const receivers = deckReceivers(body);
  // ★ `[(=]` COUNTS `===` AS AN ASSIGNMENT. Latent while the receiver was hard-coded to `deck`;
  // the moment receivers were derived, `d.padMode === "roll"` in the MIDI-feedback loop read as a
  // write and the scan demanded a gate on a loop that only lights lamps. A guard that cannot tell a
  // comparison from an assignment buys its sensitivity with false alarms, and false alarms are paid
  // for in exemptions — which is how a derived list turns back into a roster.
  const TOUCH = "\\s*(?:\\(|=(?!=))";
  return writers.some(
    (w) =>
      receivers.some((r) => new RegExp(`\\b${r}\\.${w}${TOUCH}`).test(body)) ||
      new RegExp(`\\w+\\.deck(?:\\s*\\([^)]*\\)|A|B)\\.${w}${TOUCH}`).test(body),
  );
};
// It is SAFE if it asks per deck whether we may drive, or if it only reads.
const ASKS = /canDriveDeckRef\.current\(|canDriveDeck\(/;

// Loops that mutate both decks WITHOUT a per-deck gate, each with why it is allowed to.
// A reason, never a name — and the reason has to survive being read by someone else.
const EXEMPT: { line: number; why: string }[] = [
  {
    line: 1416,
    why:
      "FX pad key RELEASE, both decks. ★ RELEASE IS THE ASYMMETRIC CASE: you must always be able to " +
      "LET GO. Gating it on canDriveDeck would leave a pad latched on a deck whose grant was revoked " +
      "mid-hold — a stuck effect, which is worse than the divergence a gate would prevent. It is " +
      "already bounded to pads THIS device pressed (fxPads.heldPads keyed by deck+slot returns false " +
      "with no press record), and the emit for a deck we cannot drive is dropped server-side by " +
      "DjRoom.canDrive. Noted rather than gated: that bound is a property of the PRESS path, so if " +
      "pad presses ever stop being per-deck gated, this exemption stops holding.",
  },
];

describe("an action that touches BOTH decks asks per deck whether it may", () => {
  const loops = bothDeckLoops(SRC);
  const drivers = drivingHelpers(SRC);
  const writers = deckWriters();

  test("the scan found loops to check (vacuity guard)", () => {
    expect(loops.length).toBeGreaterThanOrEqual(3);
  });

  test("it sees the for-of form too, not only .forEach (the gap that hid fxKeyUp)", () => {
    expect(loops.some((l) => l.body.startsWith("for ("))).toBe(true);
  });

  test("the deck-writer list is DERIVED from Deck.ts and covers the forms the old pattern missed", () => {
    // An empty or thin list would make `mutates` say "no mutation" about everything and the whole
    // scan would pass silently — the derivation guard is the only thing that notices.
    expect(writers.length).toBeGreaterThanOrEqual(50);
    for (const w of ["setTempo", "setPitch", "seek", "play", "cuePoint", "hotCues"]) expect(writers).toContain(w);
    // …and a getter is NOT a writer: the class's own `get` is what says so.
    expect(writers).not.toContain("stretchAttached");
  });

  test("the driving-helper list is DERIVED and non-empty — an empty one silently weakens MUTATES", () => {
    expect(drivers.length).toBeGreaterThan(0);
    expect(drivers).toContain("fxKeyUp");
  });

  test("every exemption names a loop that is actually there and actually mutates", () => {
    const stale = EXEMPT.filter((e) => !loops.some((l) => Math.abs(e.line - l.at) < 3 && mutates(l.body, drivers, writers)));
    expect(stale.map((e) => `EXEMPT App.tsx:${e.line} no longer matches a mutating both-deck loop`)).toEqual([]);
  });

  test("every both-deck loop that mutates a deck gates per deck", () => {
    const offenders = loops
      .filter((l) => mutates(l.body, drivers, writers) && !ASKS.test(l.body))
      .filter((l) => !EXEMPT.some((e) => Math.abs(e.line - l.at) < 3))
      .map((l) => `App.tsx:${l.at} mutates both decks without asking canDriveDeck`);
    expect(offenders).toEqual([]);
  });
});
