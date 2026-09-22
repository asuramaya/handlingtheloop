import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ★ THE CROSSFADER IS A WHOLE-BOARD MOVE, and a watch-only participant must not make it — not
// because it would reach the session (App's `emit` is gated on room.controlling and would drop it)
// but because it changes what THIS device hears, and the operator's rule is that performers and
// listeners stay synced. Its only guards were `.xfader-bar.locked { pointer-events: none }` and the
// stage shield, while setup.css claimed the handlers were gated too. They were not, for this path.
//
// Same reason the drop-guard scan exists (listenerDropGuards.test.ts): the mutator is inside a
// component tree that needs a DOM, a real engine and a room, so there is nothing pure to call —
// but "this mutator checks the lock" is cheap to assert, and cheap to keep true.
const APP = readFileSync(join(__dirname, "..", "App.tsx"), "utf8");

/** The body of a named useCallback mutator — bounded by the NEXT declaration, never a fixed width.
 *  ★ A fixed slice reaches into the next function, so a neighbour's guard reads as this one's and a
 *  missing guard passes. Deckard's sibling scan had exactly that hole: stripping every guard left
 *  one case green because the window overran into a surviving check. */
function callbackBody(name: string): string {
  const i = APP.indexOf(`const ${name} = useCallback(`);
  if (i < 0) return "";
  const after = APP.indexOf("\n  const ", i + 1);
  return APP.slice(i, after < 0 ? i + 900 : Math.min(after, i + 900));
}

describe("watch-only board guards", () => {
  it("dragCrossfade exists (a rename must not silently empty this test)", () => {
    expect(callbackBody("dragCrossfade")).not.toBe("");
  });
  it("dragCrossfade refuses while the board is locked", () => {
    expect(callbackBody("dragCrossfade")).toMatch(/if \(lockedRef\.current\) return/);
  });
});
