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

/** The body of a named useCallback mutator, far enough to see its guards. */
function callbackBody(name: string): string {
  const i = APP.indexOf(`const ${name} = useCallback(`);
  return i < 0 ? "" : APP.slice(i, i + 900);
}

describe("watch-only board guards", () => {
  it("dragCrossfade exists (a rename must not silently empty this test)", () => {
    expect(callbackBody("dragCrossfade")).not.toBe("");
  });
  it("dragCrossfade refuses while the board is locked", () => {
    expect(callbackBody("dragCrossfade")).toMatch(/if \(lockedRef\.current\) return/);
  });
});
