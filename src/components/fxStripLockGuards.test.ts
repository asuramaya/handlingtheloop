import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ★ THE SAME INVARIANT AS listenerDropGuards, one layer up. A watch-only deck's rack may be READ
// and its tabs picked (that tap is also the phone's page turn), so `.bank.locked` no longer covers
// the tab row — setup.css opens exactly that hole. The moment a blanket has a hole in it, the
// blanket is not the guard, so every function in FxStrip that CHANGES the rack has to refuse on
// its own. Hardware reaches these same functions (the FLX knobs, the gamepad, useMidiRouting), so
// this is not only about taps.
//
// A SOURCE TEST, like its sibling: rendering FxStrip needs a DOM, a real Deck and a live rack, and
// none of that makes the invariant any truer. What matters is that no mutator is left open.
const SRC = readFileSync(join(__dirname, "FxStrip.tsx"), "utf8");

// Every helper that writes to the deck's rack or broadcasts a change.
const MUTATORS = [
  "setChainStems",
  "addChain",
  "addDeviceToChain",
  "removeDeviceFromChain",
  "removeChain",
  "reorder",
  "moveSelBy",
  "syncDevice",
  "applyPreset",
  "applyChainPreset",
  "applyDefault",
  "applyPresetNamed",
  "toggleBypass",
];

function body(name: string): string {
  const at = SRC.indexOf(`const ${name} = `);
  expect(at, `${name} not found — renamed? then this test is stale, not passing`).toBeGreaterThan(-1);
  return SRC.slice(at, at + 400);
}

describe("FxStrip refuses rack changes on a watch-only deck", () => {
  it("takes the prop at all (without it every case below is vacuous)", () => {
    expect(SRC).toMatch(/locked\?: boolean/);
    expect(SRC).toMatch(/locked = false \}: FxStripProps/);
  });

  for (const name of MUTATORS) {
    it(`${name} guards on locked`, () => {
      expect(body(name)).toMatch(/if \(locked\) return/);
    });
  }

  it("but LOOKING stays live — picking which effect is on screen is not a change", () => {
    expect(body("select")).not.toMatch(/if \(locked\) return/);
  });

  it("and the menus that would mutate never open while locked", () => {
    expect(SRC).toMatch(/tabLong = useLongPress<number>\([\s\S]{0,200}?if \(locked\) return/);
    expect(SRC).toMatch(/chainLong = useLongPress<string>\([\s\S]{0,200}?if \(locked\) return/);
  });
});
