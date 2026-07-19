import { describe, test, expect } from "vitest";
import {
  KEY_ACTIONS,
  DEFAULT_BINDINGS,
  mergeBindings,
  bindingIndex,
  bindingConflicts,
  codeLabel,
  type KeyBindings,
} from "./keybinds";

// --- mergeBindings -----------------------------------------------------------
// Intent: user-saved bindings layer over the full default set so EVERY action is
// always resolvable, even for an older/partial saved map (the backfill that stops
// a newly-shipped action from having no key).

describe("mergeBindings", () => {
  test("undefined saved → returns the full DEFAULT_BINDINGS (every action present)", () => {
    const merged = mergeBindings(undefined);
    // Every declared action id is present and equal to its default.
    for (const a of KEY_ACTIONS) {
      expect(merged[a.id]).toEqual(DEFAULT_BINDINGS[a.id]);
    }
    // Same number of keys — nothing extra, nothing missing.
    expect(Object.keys(merged).sort()).toEqual(Object.keys(DEFAULT_BINDINGS).sort());
  });

  test("a couple of real defaults resolve to their documented codes", () => {
    const merged = mergeBindings(undefined);
    // From the source: play=Space, sync=KeyS, jogBackBeat=ArrowLeft, hotcue1=Digit1.
    expect(merged.play.primary).toBe("Space");
    expect(merged.sync.primary).toBe("KeyS");
    expect(merged.jogBackBeat.primary).toBe("ArrowLeft");
    expect(merged.hotcue1.primary).toBe("Digit1");
  });

  test("a PARTIAL saved map: user entries win AND the backfill keeps every default", () => {
    // User rebound just two actions (a partial/older map).
    const saved: KeyBindings = {
      play: { primary: "Enter", secondary: "Numpad0" },
      sync: { primary: "KeyA", secondary: "KeyJ" },
    };
    const merged = mergeBindings(saved);

    // User overrides win.
    expect(merged.play).toEqual({ primary: "Enter", secondary: "Numpad0" });
    expect(merged.sync).toEqual({ primary: "KeyA", secondary: "KeyJ" });

    // The backfill: every other default action is still present with its default code.
    expect(merged.cue).toEqual(DEFAULT_BINDINGS.cue); // KeyC, untouched by the partial
    expect(merged.loopIn.primary).toBe("KeyQ");
    expect(merged.muteVocals.primary).toBe("KeyN");

    // No action is dropped: the merged set covers the full action list.
    expect(Object.keys(merged).sort()).toEqual(KEY_ACTIONS.map((a) => a.id).sort());
  });

  test("a partial entry that only sets `primary` still fills `secondary` from the default", () => {
    // saved has primary only — the spread merge keeps the default secondary ("").
    const saved: KeyBindings = { play: { primary: "Enter" } as KeyBindings[string] };
    const merged = mergeBindings(saved);
    expect(merged.play.primary).toBe("Enter");
    expect(merged.play.secondary).toBe(""); // backfilled from DEFAULT_BINDINGS
  });
});

// --- bindingIndex ------------------------------------------------------------
// Intent: code → actionId Map, covering BOTH primary and secondary codes, for the
// keydown dispatcher.

describe("bindingIndex", () => {
  test("primary codes resolve to their action id", () => {
    const idx = bindingIndex(DEFAULT_BINDINGS);
    expect(idx.get("Space")).toBe("play");
    expect(idx.get("KeyA")).toBe("keyMatch");
    expect(idx.get("KeyS")).toBe("sync");
    expect(idx.get("ArrowLeft")).toBe("jogBackBeat");
  });

  test("a SECONDARY code resolves to its action", () => {
    const b = mergeBindings({ play: { primary: "Space", secondary: "Numpad0" } });
    const idx = bindingIndex(b);
    expect(idx.get("Numpad0")).toBe("play"); // secondary maps too
    expect(idx.get("Space")).toBe("play"); // primary still maps
  });

  test("blank ('') primary/secondary are NOT indexed", () => {
    // beatLoop0..7 ship with defaultKey "" — they must not create a "" key in the Map.
    const idx = bindingIndex(DEFAULT_BINDINGS);
    expect(idx.has("")).toBe(false);
  });

  // COLLISION BEHAVIOR — documented, not asserted-as-correct.
  // bindingIndex iterates KEY_ACTIONS in order and unconditionally `m.set(code, id)`.
  // When two actions share the same code, the LAST one written (later in KEY_ACTIONS,
  // or a secondary written after a primary in the same iteration) silently WINS — the
  // earlier action becomes unreachable from the keyboard with no warning.
  // NOTE: this is a real footgun — a user (or a shipped default) that double-binds a
  //       code silently loses the earlier action. See keybinds.ts:95-103.
  test("collision: a later action's primary overwrites an earlier action's code (last-write-wins)", () => {
    // Use F9 — a code no other default claims — so this isolates the sync↔keyMatch collision.
    const b = mergeBindings({
      sync: { primary: "F9", secondary: "" }, // sync is earlier in KEY_ACTIONS
      keyMatch: { primary: "F9", secondary: "" }, // keyMatch immediately after
    });
    const idx = bindingIndex(b);
    // keyMatch comes AFTER sync in KEY_ACTIONS → it wins; sync's F9 is shadowed.
    expect(idx.get("F9")).toBe("keyMatch");
  });

  test("collision: within ONE action, secondary is written after primary — if equal, primary value stands", () => {
    // primary and secondary identical: set(code, id) twice with the SAME id → still that id.
    const b = mergeBindings({ cue: { primary: "KeyC", secondary: "KeyC" } });
    const idx = bindingIndex(b);
    expect(idx.get("KeyC")).toBe("cue");
  });

  test("collision: an action's OWN secondary overwriting a DIFFERENT earlier action's primary", () => {
    // play.primary=Space (action 'play' early). Give a later action 'cue' a secondary of Space.
    const b = mergeBindings({
      play: { primary: "Space", secondary: "" },
      cue: { primary: "KeyC", secondary: "Space" },
    });
    const idx = bindingIndex(b);
    // cue is later in KEY_ACTIONS and its secondary Space is written after play's primary.
    // 'play' loses Space — but it's no longer SILENT: bindingConflicts surfaces it (below).
    expect(idx.get("Space")).toBe("cue");
  });
});

// --- bindingConflicts --------------------------------------------------------
// The companion that makes a collision visible (the Keys editor renders a warning), so the
// last-write-wins orphaning above is never silent.
describe("bindingConflicts", () => {
  test("the shipped DEFAULT map is collision-free", () => {
    // A self-colliding default would silently orphan an action on a fresh install — guard it.
    expect(bindingConflicts(DEFAULT_BINDINGS).size).toBe(0);
  });

  test("reports a code claimed by two different actions, in KEY_ACTIONS order", () => {
    const b = mergeBindings({ sync: { primary: "F9", secondary: "" }, keyMatch: { primary: "F9", secondary: "" } });
    const c = bindingConflicts(b);
    expect(c.get("F9")).toEqual(["sync", "keyMatch"]); // sync earlier than keyMatch
    expect(c.size).toBe(1);
  });

  test("catches the version-drift case: a saved binding colliding with a shipped default", () => {
    // slip's DEFAULT primary is KeyK; an older saved map bound spinback to KeyK too.
    const b = mergeBindings({ spinback: { primary: "KeyK", secondary: "" } });
    expect(bindingConflicts(b).get("KeyK")).toEqual(["spinback", "slip"]);
  });

  test("an action reusing the SAME code for its own primary + secondary is NOT a conflict", () => {
    const b = mergeBindings({ cue: { primary: "KeyC", secondary: "KeyC" } });
    expect(bindingConflicts(b).has("KeyC")).toBe(false);
  });

  test("blank slots never count as a collision", () => {
    // Every beatLoop default is "" — many actions share the empty string but it's not a conflict.
    expect(bindingConflicts(DEFAULT_BINDINGS).has("")).toBe(false);
  });
});

// --- codeLabel ---------------------------------------------------------------

describe("codeLabel", () => {
  test("KeyA-style codes → the bare letter", () => {
    expect(codeLabel("KeyA")).toBe("A");
    expect(codeLabel("KeyZ")).toBe("Z");
  });

  test("Digit codes → the bare digit", () => {
    expect(codeLabel("Digit1")).toBe("1");
    expect(codeLabel("Digit8")).toBe("8");
  });

  test("Numpad digit codes → 'Num N'", () => {
    expect(codeLabel("Numpad0")).toBe("Num 0");
    expect(codeLabel("Numpad5")).toBe("Num 5");
  });

  test("arrow codes → their symbols", () => {
    expect(codeLabel("ArrowLeft")).toBe("←");
    expect(codeLabel("ArrowRight")).toBe("→");
    expect(codeLabel("ArrowUp")).toBe("↑");
    expect(codeLabel("ArrowDown")).toBe("↓");
  });

  test("named specials from the lookup", () => {
    expect(codeLabel("Enter")).toBe("Enter");
    expect(codeLabel("Space")).toBe("Space");
    expect(codeLabel("Escape")).toBe("Esc");
    expect(codeLabel("Minus")).toBe("−");
    expect(codeLabel("Equal")).toBe("+");
    expect(codeLabel("BracketLeft")).toBe("[");
  });

  test("empty code → empty string", () => {
    expect(codeLabel("")).toBe("");
  });

  test("an unknown code falls through to itself", () => {
    expect(codeLabel("F13")).toBe("F13");
    expect(codeLabel("MediaPlayPause")).toBe("MediaPlayPause");
  });
});
