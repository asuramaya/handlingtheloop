// THE FX SELECT BOARD MENU (operator, 2026-11-08: FX SELECT press "to trigger the plus button, then
// repurpose the left right arrows to allow me to select through the menu, another press would select
// the effect…"). The design that was agreed fixes the plan's holes (an accidental SHIFT deleting a
// dialled effect, no way out, a modifier that changed meaning by context, no back for the nesting,
// and losing quick preset cycling) with ONE grammar that never changes meaning:
//   PRESS        = go in / choose
//   SHIFT+PRESS  = back one level; at the top, close (undoing an auditioned preset)
//   BEAT ◀ / ▶   = move the highlight (wraps)
// It opens on the SELECTED effect's own menu — its presets, the highlight on the one in use — with
// "＋ Add effect" and "✕ Remove" under them. Landing on a preset AUDITIONS it (applies it live), so
// "press, ▶, ▶" is quick preset browsing you can back out of. Remove takes a second press.
//
// This module is the pure state machine: no React, no deck. FxStrip renders the state and carries
// out the `Effect`s it returns (apply / revert / add / remove / close).

export interface PresetLike {
  name: string;
  params: Record<string, number>;
}

export type BoardRow =
  | { t: "default" } // the device's own reset state
  | { t: "preset"; preset: PresetLike }
  | { t: "section"; name: string; items: BoardRow[] }
  | { t: "add" } // ＋ Add effect
  | { t: "remove" } // ✕ Remove (press twice)
  | { t: "kind"; kind: string; label: string }; // an effect in the add list

export interface BoardLevel {
  /** What this level is about: "edit" = the selected effect's presets (auditioned live); "add" =
   *  the effect list, or (with `kind`) a not-yet-added effect's presets (never auditioned). */
  mode: "edit" | "add";
  kind?: string;
  title: string;
  rows: BoardRow[];
  cursor: number;
}

export interface BoardState {
  stack: BoardLevel[];
  /** "✕ Remove" was pressed once: the next press removes, any other gesture cancels. */
  confirmRemove: boolean;
  /** A preset is auditioned (the effect is not as it was when the menu opened). */
  auditioning?: boolean;
}

/** What the strip must do as a result of a gesture. */
export type BoardEffect =
  | { t: "audition"; row: BoardRow } // apply a preset (or Default) to the selected effect, live
  | { t: "keep" } // close, keeping what is applied
  | { t: "revert" } // close, restoring the effect to how it was when the menu opened
  | { t: "restore" } // stay open, restoring the effect to how it was when the menu opened
  | { t: "add"; kind: string; preset: PresetLike | null } // add the effect with that preset (null = Default)
  | { t: "remove" }; // take the selected effect out of its chain, then close

/** What a press needs from the strip: the effects that can be added right now (not already in the
 *  chain), and a not-yet-added effect's preset rows (Default first). */
export interface BoardSource {
  addList: () => BoardRow[];
  kindRows: (kind: string) => BoardRow[];
}

export const top = (s: BoardState): BoardLevel => s.stack[s.stack.length - 1];
export const currentRow = (s: BoardState): BoardRow | undefined => {
  const l = top(s);
  return l?.rows[l.cursor];
};

const isPresetRow = (r: BoardRow | undefined) => r?.t === "preset" || r?.t === "default";

/** Open on the selected effect: its rows, then ＋ Add / ✕ Remove, the highlight on `activeName`
 *  ("" = Default). */
export function openBoard(title: string, kind: string, presetRows: BoardRow[], activeName: string): BoardState {
  const rows: BoardRow[] = [{ t: "default" }, ...presetRows, { t: "add" }, { t: "remove" }];
  let cursor = 0;
  if (activeName) {
    const i = rows.findIndex((r) => r.t === "preset" && r.preset.name === activeName);
    if (i >= 0) cursor = i;
  }
  return { stack: [{ mode: "edit", kind, title, rows, cursor }], confirmRemove: false };
}

/** Leaving the presets (onto a section, ＋ Add, ✕ Remove, or back out to one) puts the effect back
 *  as it was when the menu opened. ★ (operator, 2026-11-08: cycling past an ungrouped preset onto
 *  the next row "will get stuck on that mode instead of reverting … probably last state".) */
function settle(state: BoardState, auditioning: boolean | undefined): { state: BoardState; effect?: BoardEffect } {
  return auditioning ? { state: { ...state, auditioning: false }, effect: { t: "restore" } } : { state };
}

/** BEAT ◀ / ▶. Wraps. In the edit level, landing on a preset auditions it, and landing on any
 *  other row undoes the audition. */
export function move(s: BoardState, dir: number): { state: BoardState; effect?: BoardEffect } {
  const l = top(s);
  if (!l || !l.rows.length) return { state: s };
  const n = l.rows.length;
  const cursor = (((l.cursor + dir) % n) + n) % n;
  const state: BoardState = { stack: [...s.stack.slice(0, -1), { ...l, cursor }], confirmRemove: false, auditioning: s.auditioning };
  const row = l.rows[cursor];
  if (l.mode !== "edit") return { state };
  if (isPresetRow(row)) return { state: { ...state, auditioning: true }, effect: { t: "audition", row } };
  return settle(state, s.auditioning);
}

/** Point the highlight at a row directly (the mouse). Never auditions — a hover is not a choice. */
export function point(s: BoardState, index: number): BoardState {
  const l = top(s);
  if (!l || index < 0 || index >= l.rows.length || index === l.cursor) return s;
  return { stack: [...s.stack.slice(0, -1), { ...l, cursor: index }], confirmRemove: false, auditioning: s.auditioning };
}

/** PRESS: go in, or choose. Returns `state: null` when the menu closes. */
export function press(s: BoardState, src: BoardSource): { state: BoardState | null; effect?: BoardEffect } {
  const l = top(s);
  const row = currentRow(s);
  if (!l || !row) return { state: s };
  switch (row.t) {
    case "section":
      return { state: { stack: [...s.stack, { mode: l.mode, kind: l.kind, title: row.name, rows: row.items, cursor: 0 }], confirmRemove: false, auditioning: s.auditioning } };
    case "default":
    case "preset":
      if (l.mode === "edit") return { state: null, effect: { t: "keep" } };
      return { state: null, effect: { t: "add", kind: l.kind ?? "", preset: row.t === "preset" ? row.preset : null } };
    case "add":
      return { state: { stack: [...s.stack, { mode: "add", title: "Add effect", rows: src.addList(), cursor: 0 }], confirmRemove: false, auditioning: s.auditioning } };
    case "kind":
      return { state: { stack: [...s.stack, { mode: "add", kind: row.kind, title: row.label, rows: src.kindRows(row.kind), cursor: 0 }], confirmRemove: false, auditioning: s.auditioning } };
    case "remove":
      if (s.confirmRemove) return { state: null, effect: { t: "remove" } };
      return { state: { ...s, confirmRemove: true } };
  }
}

/** SHIFT+PRESS: back one level; at the top, close and undo any audition. */
export function back(s: BoardState): { state: BoardState | null; effect?: BoardEffect } {
  if (s.confirmRemove) return { state: { ...s, confirmRemove: false } }; // first, a pending remove is cancelled
  if (s.stack.length > 1) {
    // back onto the section row: that is not a preset, so the audition made inside it is undone
    const state: BoardState = { stack: s.stack.slice(0, -1), confirmRemove: false, auditioning: s.auditioning };
    return top(state).mode === "edit" ? settle(state, s.auditioning) : { state };
  }
  return { state: null, effect: { t: "revert" } };
}
