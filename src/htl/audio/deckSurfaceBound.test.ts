import { describe, test, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { stripComments } from "../testing/sourceScan";

// ★ THE POPULATION IS DERIVED, NOT LISTED — which is the whole difference between this and a
// roster, and the reason it exists beside src/App/deckApply.test.ts rather than inside it.
//
// That test states the right invariant (the bound is the narrowed INTERFACE, not the module) and
// then checks it against `const APPLIERS = [two paths]`. Fixing a roster of one by making it a
// roster of two leaves the failure mode exactly where it was: the module that gets this property
// tomorrow is not checked, and nothing says so. It found applyIntent because a design discussion
// happened to notice it. Nothing was going to find the next one.
//
// Run against the derived population, it immediately turned up a THIRD module that already had the
// property and was unprotected: src/htl/room/fxWire.ts, which bounds itself to a ONE-member
// `FxWireDeck` and a three-member `FxRackDeck`. It is not an applier — it only reads, to build
// intents — which is the second thing the roster got wrong. The invariant was never about applying.
// It is: A MODULE THAT DECLARES ITS OWN DECK SURFACE MUST NOT ALSO REACH FOR THE WIDE ONE.
//
// ★ WHAT THIS CANNOT DO, said plainly rather than left for someone to discover. It protects modules
// that CLAIM the bound. It cannot find a module that should have claimed it and did not, because
// "should have" is not a property of the source text. Deriving that population was tried and
// abandoned honestly: matching `.<writerName>(` against Deck's 167 derived writers returns 62
// modules, most of them false — `play`, `stop` and `set*` are method names on Eq3, NoiseFx and
// LoopEngine too, and a bare method name does not say what the receiver was. A scan whose
// population is mostly wrong is worse than one whose scope is narrow and stated.
const root = fileURLToPath(new URL("../../..", import.meta.url));
const IFACE = /export interface (\w*Deck)\b/g;

/** The members of an interface body that are CALL SIGNATURES — `seek(t: number): void`.
 *
 *  ★ THE NAME IS NOT THE THING, and keying on it put a false positive in the population on the
 *  first run: src/components/LyricsSettings.tsx declares `LyricDeck`, which is a per-deck VIEW
 *  MODEL — `{ id, source, lines, status }`, four data fields and no methods. It is not a bounded
 *  deck surface and bounding it would mean nothing. It also imports no audio, so it would have
 *  PASSED every assertion below and quietly padded the count — a false positive that fails is a
 *  nuisance, one that passes makes the scan look like it covered more than it did.
 *
 *  So the discriminator is structural: a bounded surface is made of methods, because a method is
 *  what a caller would otherwise have reached for on the wide Deck. This repo has been bitten by
 *  the naming-convention-as-derivation shape before (bothDeckActionScan's `deck.set[A-Z]`). */
function methodsOf(code: string, name: string): Set<string> {
  const body = code.slice(code.indexOf(`export interface ${name}`));
  const inner = body.slice(body.indexOf("{") + 1, body.indexOf("\n}"));
  return new Set([...inner.matchAll(/^\s+(?:readonly\s+)?([a-zA-Z_]\w*)\s*\(/gm)].map((m) => m[1]));
}

function sources(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (/\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

/** Every module declaring a deck surface of its own — the modules that claim the bound. */
function bounded(): { path: string; code: string; ifaces: string[] }[] {
  const out: { path: string; code: string; ifaces: string[] }[] = [];
  for (const f of sources(join(root, "src"))) {
    const code = stripComments(readFileSync(f, "utf8"));
    // A claimant declares at least one interface MADE OF METHODS — see methodsOf.
    const ifaces = [...code.matchAll(IFACE)].map((m) => m[1]).filter((n) => methodsOf(code, n).size > 0);
    // Deck.ts itself declares the wide surface; it is the subject, never a claimant.
    if (ifaces.length && !/htl\/audio\/Deck\.ts$/.test(f)) out.push({ path: f.slice(root.length), code, ifaces });
  }
  return out;
}

/** Deck's whole public surface — the thing a `deck: Deck` annotation hands over. */
function deckMembers(): Set<string> {
  const src = readFileSync(join(root, "src/htl/audio/Deck.ts"), "utf8");
  const klass = src.slice(src.indexOf("export class Deck"));
  const m = new Set(
    [...klass.matchAll(/^  (?!private |protected |\/\/|\*|\/\*)(?:readonly\s+|get\s+|set\s+)?([a-zA-Z_]\w*)\s*[(=:]/gm)].map((x) => x[1]),
  );
  m.delete("constructor");
  return m;
}

const MODULES = bounded();
const MEMBERS = deckMembers();

describe("every module that declares its own deck surface is bounded by it", () => {
  // ★ VACUITY FIRST. Every assertion below is inside a loop over a derived list, and a derivation
  // that breaks returns an empty list, which passes silently and loudly claims to have checked.
  test("the derivation finds the modules we already know have this property", () => {
    expect(MEMBERS.size, "Deck.ts no longer parses the way this scan reads it").toBeGreaterThan(100);
    const paths = MODULES.map((m) => m.path);
    // Named as a CROSS-CHECK on the instrument, not as the population: if the derivation stops
    // seeing these three, the derivation is broken, and that is what this test reports.
    for (const known of ["src/App/deckApply.ts", "src/htl/room/applyIntent.ts", "src/htl/room/fxWire.ts"]) {
      expect(paths, `the derivation no longer sees ${known}`).toContain(known);
    }
    expect(MODULES.length).toBeGreaterThanOrEqual(3);
  });

  for (const { path, code, ifaces } of MODULES) {
    test(`${path} imports nothing from the audio layer`, () => {
      const imports = [...code.matchAll(/^\s*import\s[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1]);
      expect(imports.filter((i) => /htl\/audio|\/Deck$|\/AudioEngine$/.test(i))).toEqual([]);
    });

    test(`${path} never USES the wide Deck type`, () => {
      // A USE, not a spelling: DeckId, DeckSnapshot and DeckMeta are ordinary data types and have
      // nothing to do with the surface being bounded.
      expect(code).not.toMatch(/\bimport\b[^;]*\bDeck\s*[,}]/);
      expect(code).not.toMatch(/:\s*Deck\b(?![A-Za-z])/);
      expect(code).not.toMatch(/<\s*Deck\b(?![A-Za-z])/);
    });

    // EVERY interface the module declares, not the first one. fxWire declares two, and a scan that
    // read only the first would have checked its 1-member surface and ignored the other.
    for (const name of ifaces) {
      // ★ THE ONE HOLE A LOCAL-TEXT COUNT CANNOT SEE, closed by forbidding it rather than by
      // importing a compiler into the gate. `methodsOf` reads the members written between this
      // interface's own braces. `export interface SnapshotDeck extends Deck` would inherit the
      // entire wide surface while the local count stayed at 38, and every assertion here would
      // still pass — the same laundering shape as shape B's `"remote"`, killed for being invisible
      // to a scan.
      //
      // The checker resolves inheritance and WAS run against this file, to calibrate the numbers
      // below (2.2s to build the program). It is not imported here because that cost lands on every
      // gate run to close a hole a one-line ban closes exactly, and because the ban says the
      // stronger thing: these surfaces are written out, not composed. scripts/deckscan/wide.ts is
      // where the checker earns its keep — on the population this file cannot derive at all.
      test(`${path}: ${name} is declared outright, not by extension`, () => {
        expect(code, `${name} extends another type — the local member count no longer bounds it`).not.toMatch(
          new RegExp(`interface\\s+${name}\\s+extends\\b`),
        );
      });

      test(`${path}: ${name} stays a small fraction of Deck's own surface`, () => {
        const named = methodsOf(code, name);
        expect(named.size, `${name} declares no methods — an empty surface passes every ratio`).toBeGreaterThan(0);
        // ★ THE THRESHOLD IS SET FROM THE MEASUREMENT, AND THE MEASUREMENT IS OF METHODS. Both sides
        // of this ratio are method counts: `methodsOf` above, and MEMBERS below, which is every
        // public member of Deck — the surface a `deck: Deck` annotation hands over.
        //
        // I published "SnapshotDeck 73 … the widest is 0.27" in the commit that added this file, and
        // 73 is the wrong quantity: it is Deckard's count from deckApply.test.ts, which counted
        // PROPERTIES. Asked of the TypeScript checker rather than a regex, SnapshotDeck is 73
        // properties of which 38 are METHODS; IntentDeck is 51 and 48; FxRackDeck 2 and 2;
        // FxWireDeck 1 and 1. So the widest ratio this test actually enforces is 38/271 = 0.14, not
        // 0.27 — a number describing a different question than the one the code asks, which is the
        // third time I have done that tonight and the second in a published figure.
        //
        // 0.40 stays: it is headroom over the real 0.14 and it is what a planted widening must beat.
        // Deckard's first threshold here was 0.70, which let a planted 95-member widening pass and
        // so asserted nothing.
        expect(named.size / MEMBERS.size).toBeLessThan(0.4);
      });
    }
  }
});
