import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ★ THE FIFTH INSTANCE OF ONE LESSON, and the last big one in the deck bank. A watch-only deck's
// pads — the sampler's, the FX bank's — and its pad-mode switch were guarded only by
// `.bank.locked { pointer-events: none }` plus the stage shield. Neither is a guard: the shield
// already moved once (d29dcd1) and took two drop handlers out of cover with it, and a hole in the
// class is exactly what the FX page will need.
//
// These mostly cannot reach the session (App's emit is gated on room.controlling), so the defect
// they prevent is LOCAL divergence: a listener's own sampler playing over a host's set, their FX
// pad throwing an effect nobody else hears. The operator's rule is that performers and listeners
// stay synced, so that is the violation.
//
// Sibling to listenerDropGuards / boardLockGuards / fxStripLockGuards: a source scan, because
// these handlers need a DOM, a live sampler and a real Deck to call — and "this mutator checks the
// lock" is cheap to assert and cheap to keep true.
const SRC = readFileSync(join(__dirname, "DeckControls.tsx"), "utf8");

const HANDLERS = [
  "changePadMode", // mutates the deck AND emits the bank switch
  "openGlbPicker", // opens the file picker that assigns a global pad
  "onGlbFile", // assigns the chosen file to a pad
  "smpDown", // grab a region / trigger / clear
  "smpUp", // release a gate voice
  "glbDown", // the global one-shot bank
  "fxReveal", // opens a device menu whose actions mutate
  "fxPadDown", // throws an effect + emits
  "fxPadUp", // releases it + emits
];

/** A handler's OWN body, stopping at the next declaration. A fixed-width window instead of this
 *  bled into the following function: removing every guard still left one case green, because the
 *  neighbour's surviving guard sat inside the window. A control caught it, which is the point. */
function body(name: string): string {
  const at = SRC.indexOf(`const ${name} = `);
  expect(at, `${name} not found — a rename makes this test stale, not passing`).toBeGreaterThan(-1);
  const rest = SRC.slice(at + `const ${name} = `.length);
  const next = rest.search(/\n  (?:const|function) /);
  return next < 0 ? rest : rest.slice(0, next);
}

describe("the deck bank refuses a watch-only touch at its handlers", () => {
  it("takes `locked` at all (without it every case below is vacuous)", () => {
    expect(SRC).toMatch(/locked\?: boolean/);
  });

  for (const name of HANDLERS) {
    it(`${name} guards on locked`, () => {
      expect(body(name)).toMatch(/if \(locked\) return/);
    });
  }

  it("the sampler's long-press menu never opens while locked", () => {
    expect(SRC).toMatch(/smpLong = useLongPress<SamplerPad>\([\s\S]{0,160}?if \(locked\) return/);
  });

  it("the class is still there, but it is the AFFORDANCE now, not the guard", () => {
    expect(SRC).toMatch(/\$\{locked \? "locked" : ""\}/);
  });
});
