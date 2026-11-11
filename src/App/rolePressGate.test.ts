import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { canDriveBoard } from "./drivePermission";

// ★ SYNC / KEY ARE BOARD-WIDE PRESSES (operator, 2026-11-11: session sync audit).
//
// A single-deck guest (a stepped-up listener holding "A" or "B") pressed SYNC: its engine engaged,
// the server refused the deck-less `sync` intent (canDriveIntent needs both decks), and the per-deck
// tempo intent that followed passed — so the ANCHOR released its lock. The rule (canDriveBoard) is
// pure and tested; what this pins is that every press path ASKS it, and that no surface emits a
// role on its own any more (one ordered path: pressSync / pressKey → syncRoles).
const APP = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");
const CONTROLS = readFileSync(new URL("../components/DeckControls.tsx", import.meta.url), "utf8");

function bodyOf(src: string, decl: string): string {
  const at = src.indexOf(decl);
  expect(at, `${decl} not found`).toBeGreaterThanOrEqual(0);
  let depth = 0;
  let i = src.indexOf("{", at);
  const from = i;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) break;
  }
  return src.slice(from, i + 1);
}

describe("SYNC / KEY presses are gated on FULL control and go through one emitting path", () => {
  test("the rule: a stage DJ holding one deck may not make a board-wide move; solo and the host may", () => {
    expect(canDriveBoard({ enabled: true, controlling: true, myDeck: "A" })).toBe(false);
    expect(canDriveBoard({ enabled: true, controlling: true, myDeck: null })).toBe(true);
    expect(canDriveBoard({ enabled: false, controlling: false, myDeck: null })).toBe(true);
  });

  test("pressSync and pressKey ask the board lock before touching the engine", () => {
    for (const name of ["const pressSync = useCallback(", "const pressKey = useCallback("]) {
      const body = bodyOf(APP, name);
      const gate = body.indexOf("boardLockedRef.current");
      const touch = Math.max(body.indexOf("doSync("), body.indexOf("engine.toggleKey("));
      expect(gate).toBeGreaterThanOrEqual(0);
      expect(gate).toBeLessThan(touch);
    }
  });

  test("keyboard/MIDI handlers and both on-screen banks route through them", () => {
    expect(bodyOf(APP, "      sync: (deck, id, s) =>")).toContain("pressSync(id)");
    expect(bodyOf(APP, "      keyMatch: (deck, id, s) =>")).toContain("pressKey(id)");
    expect(APP.match(/onSync=\{\(\) => pressSync\("[AB]"\)\}/g)?.length).toBe(2);
    expect(APP.match(/onKey=\{\(\) => pressKey\("[AB]"\)\}/g)?.length).toBe(2);
    expect(APP.match(/roleLocked=\{boardLocked\}/g)?.length).toBe(2);
  });

  test("no surface hand-builds a sync/key intent any more (it would skip the ordered state)", () => {
    expect(APP).not.toMatch(/kind: "sync", slave:/);
    expect(APP).not.toMatch(/kind: "key", slave:/);
  });

  test("the on-screen SYNC/KEY buttons are visibly disabled when role-locked", () => {
    expect(CONTROLS.match(/disabled=\{roleLocked\}/g)?.length).toBe(2);
  });
});
