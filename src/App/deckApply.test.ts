import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { stripComments } from "../htl/testing/sourceScan";

// ★ THE MODULE IS NOT THE BOUND — THE NARROWED INTERFACE IS, and the difference is one import.
//
// A module that imports the full Deck bounds nothing: it moves the same 163-member surface behind a
// different filename and reads as progress. What makes src/htl/room/applyIntent.ts a real bound is
// that it declares its own `IntentDeck` and imports NOTHING from the audio layer — the real Deck
// satisfies it structurally, with no import and no change on Deck's side. deckApply.ts copies that.
//
// So the check is the import, not the interface: an interface can be narrowed today and widened
// tomorrow by one line that nobody reads as a design change. This fails on that line.
//
// Both files are checked, not just the new one. Pinning only the module I happened to write is the
// roster habit — applyIntent has had this property since before the design discussion that noticed
// it was the point, and nothing was stopping it from losing it.
const APPLIERS = ["src/App/deckApply.ts", "src/htl/room/applyIntent.ts"];

describe("an applying module declares its own deck surface and imports none of the audio layer", () => {
  for (const path of APPLIERS) {
    const src = readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
    // ★ COMMENTS ARE NOT CODE, and both of these files EXPLAIN the rule in prose that names the
    // very type the rule forbids ("the real Deck satisfies it structurally"). The first run of this
    // test failed on its own subject's documentation — the repo already owns the fix for that.
    const code = stripComments(src);
    const imports = [...code.matchAll(/^\s*import\s[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1]);

    test(`${path} imports nothing from the audio layer`, () => {
      // Anything under htl/audio drags the concrete Deck (or a type that names it) back in.
      expect(imports.filter((i) => /htl\/audio|\/Deck$|\/AudioEngine$/.test(i))).toEqual([]);
    });

    test(`${path} never USES the wide Deck type`, () => {
      // A type-only import is still the bound gone: one `deck: Deck` accepts every mutator again.
      // Checked as code, and as a USE rather than a spelling — `DeckSnapshot`/`DeckMeta` are
      // ordinary data types and have nothing to do with the surface being bounded.
      expect(code).not.toMatch(/\bimport\b[^;]*\bDeck\s*[,}]/); // import { Deck } / { Deck, … }
      expect(code).not.toMatch(/:\s*Deck\b(?![A-Za-z])/); // an annotation: `deck: Deck`
      expect(code).not.toMatch(/<\s*Deck\b(?![A-Za-z])/); // a type argument: Array<Deck>
    });

    test(`${path} declares a deck interface of its own`, () => {
      // The vacuity guard: with no interface the two tests above pass while the module does its
      // work against `any`, which is the same surface it was supposed to give up.
      expect(code).toMatch(/export interface \w*Deck\b/);
    });
  }

  const code = stripComments(readFileSync(new URL("./deckApply.ts", import.meta.url), "utf8"));

  test("the narrowed surface stays a small fraction of Deck's own", () => {
    // ★ SAY WHICH POPULATION, because three different counts of "Deck's surface" are in circulation
    // and they answer three different questions: 163 (Metron's, members an intent could name), 182
    // (public WRITERS, what bothDeckActionScan derives), 271 (every public member, getters included).
    // This one is 271 — the whole surface a `deck: Deck` annotation would hand over, which is the
    // thing SnapshotDeck exists to not hand over.
    const deck = readFileSync(new URL("../htl/audio/Deck.ts", import.meta.url), "utf8");
    const klass = deck.slice(deck.indexOf("export class Deck"));
    const members = new Set(
      [...klass.matchAll(/^  (?!private |protected |\/\/|\*|\/\*)(?:readonly\s+|get\s+|set\s+)?([a-zA-Z_]\w*)\s*[(=:]/gm)].map((m) => m[1]),
    );
    members.delete("constructor");
    const iface = code.slice(code.indexOf("export interface SnapshotDeck"));
    const named = new Set(
      [...iface.slice(0, iface.indexOf("\n}")).matchAll(/^\s+(?:readonly\s+)?([a-zA-Z_]\w*)[(?:]/gm)].map((m) => m[1]),
    );
    expect(members.size).toBeGreaterThan(100); // vacuity: an empty class list makes any ratio pass
    expect(named.size).toBeGreaterThan(20); // …and a surface too thin to do the job is its own bug
    // MEASURED at 73/271 = 0.27 when written. 0.40 is that plus real headroom, and it is set from
    // the measurement rather than guessed: the first threshold here was 0.70, which let a planted
    // 95-member widening through and so asserted nothing. A bound whose slack was never measured is
    // the same defect as a constant justified by the wrong quantity.
    expect(named.size / members.size).toBeLessThan(0.4);
  });
});
