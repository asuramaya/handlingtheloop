import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// The listener's input shield, asserted against the stylesheets themselves — the same trick
// phoneBoardLayout.test.ts uses, because these are layout facts no unit test can reach.
//
// WHAT THIS PINS: the shield covers the CONTROLS, not the whole stage. It used to cover the
// stage, and that also swallowed the gestures that only LOOK — choosing which deck is on screen
// (on a phone the other one is display:none), zoom and expand. A listener could not watch the
// host work the other deck.
const css = (f: string) => readFileSync(resolve(__dirname, f), "utf8");
const fx = css("fx.css");
const board = css("board.css");

/** The selector block a rule lives in, for `prop`, searching from the rule's own declaration. */
function blockFor(sheet: string, selector: string): string {
  const at = sheet.indexOf(`${selector} {`);
  expect(at, `${selector} not found`).toBeGreaterThan(-1);
  return sheet.slice(at, sheet.indexOf("}", at));
}

describe("the listener input shield", () => {
  test("is positioned against the CONTROLS region, not the whole stage", () => {
    expect(blockFor(fx, ".decks-third")).toMatch(/position:\s*relative/);
    // A bare `.stage { position: relative }` in this file is what scoped it to the whole stage.
    expect(fx).not.toMatch(/\n\.stage \{[^}]*position:\s*relative/);
  });

  test("still covers its container completely and outranks the deck surface", () => {
    const shield = blockFor(fx, ".stage-lock");
    expect(shield).toMatch(/position:\s*absolute/);
    expect(shield).toMatch(/inset:\s*0/);
    // Only the DECK SURFACE has to sit under it. Modal backdrops (40), the FX menu catcher (40)
    // and the chin (5000) are deliberately above: an overlay a listener is allowed to use must
    // not be swallowed, and none of them is reachable while the controls beneath are shielded.
    const deckLayers = Array.from(board.matchAll(/(\.(?:bank|lane|lanes|deck)[^{]*)\{([^}]*)\}/g))
      .flatMap(([, , body]) => Array.from(body.matchAll(/z-index:\s*(\d+)/g), (m) => Number(m[1])));
    expect(deckLayers.length).toBeGreaterThan(0);
    expect(Number(/z-index:\s*(\d+)/.exec(shield)?.[1])).toBeGreaterThan(Math.max(...deckLayers));
  });

  test("the phone really does hide the unfocused deck — which is why looking had to be freed", () => {
    expect(board).toMatch(/\.bank:not\(\.focused\)\s*\{\s*display:\s*none/);
  });
});
