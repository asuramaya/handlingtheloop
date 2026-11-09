// THE FX SELECT BOARD CURSOR (operator, 2026-11-08). The board drives the SAME menus the mouse
// opens — the effect's right-click preset menu with its section flyouts, and the ＋ add picker with
// its effect → preset flyouts. ("making the menus the same even the flyovers so there is not two
// menus".) It used to draw a second, board-only menu; that is gone. This module is only the cursor:
// which row of which window is highlighted, and what a gesture does. FxStrip owns the windows.
//
// The grammar, with a menu open:
//   BEAT ◀ / ▶      = move the highlight through the window it is in (wraps)
//   PRESS           = go in (a section / an effect opens its flyout) or choose (a preset)
//   SHIFT+BEAT ◀    = back one window; at the top, close (undoing an audition)
// In the preset menu, landing on a preset (or Default) AUDITIONS it — it is applied live — and
// landing on anything else puts the effect back as it was when the menu opened. The add picker
// never auditions: nothing is in the chain yet.
//
// Every row carries `at`, its index in the list the window actually renders (-1 = the pinned
// Default in the chin), so the strip can mark the highlighted element without re-deriving the
// order — and rows the window skips (a dangling factory reference) are simply absent here too.

export interface PresetLike {
  name: string;
  params: Record<string, number>;
}

export type BoardRow =
  | { t: "default"; at: -1 } // the device's own reset state, pinned in the window's chin
  | { t: "preset"; at: number; preset: PresetLike }
  | { t: "section"; at: number; name: string; items: BoardRow[] }
  | { t: "kind"; at: number; kind: string }; // an effect in the add picker

export interface BoardLevel {
  rows: BoardRow[];
  cursor: number;
  /** The effect this window's presets belong to (add picker flyouts: what PRESS adds). */
  kind?: string;
}

export interface BoardState {
  /** "edit" = the selected effect's preset menu; "add" = the ＋ picker. */
  mode: "edit" | "add";
  stack: BoardLevel[];
  /** A preset is auditioned: the effect is not as it was when the menu opened. */
  auditioning: boolean;
}

/** What the strip must do as a result of a gesture. */
export type BoardEffect =
  | { t: "audition"; row: BoardRow } // apply a preset (or Default) to the effect, live
  | { t: "restore" } // stay open; put the effect back as it was when the menu opened
  | { t: "keep" } // close, keeping what is applied
  | { t: "revert" } // close, putting the effect back as it was when the menu opened
  | { t: "close" } // close (the add picker: nothing to undo)
  | { t: "add"; kind: string; preset: PresetLike | null }; // add that effect with that preset (null = Default)

/** An effect's preset rows for the add picker's flyout, or null when it has none (PRESS then adds
 *  it straight away with Default, as a click on the name does). */
export interface BoardSource {
  kindRows: (kind: string) => BoardRow[] | null;
}

export const top = (s: BoardState): BoardLevel => s.stack[s.stack.length - 1];
export const currentRow = (s: BoardState): BoardRow | undefined => {
  const l = top(s);
  return l?.rows[l.cursor];
};
const isPresetRow = (r: BoardRow | undefined) => r?.t === "preset" || r?.t === "default";
const DEFAULT: BoardRow = { t: "default", at: -1 };

/** Open the preset menu: its rows then Default (the chin), the highlight on `activeName` ("" =
 *  Default) — inside its section when that is where it lives. */
export function openEdit(rows: BoardRow[], activeName: string): BoardState {
  const all = [...rows, DEFAULT];
  const last = all.length - 1;
  if (activeName) {
    const i = all.findIndex((r) => r.t === "preset" && r.preset.name === activeName);
    if (i >= 0) return { mode: "edit", stack: [{ rows: all, cursor: i }], auditioning: false };
    for (let s = 0; s < all.length; s++) {
      const r = all[s];
      if (r.t !== "section") continue;
      const j = r.items.findIndex((x) => x.t === "preset" && x.preset.name === activeName);
      if (j >= 0) return { mode: "edit", stack: [{ rows: all, cursor: s }, { rows: r.items, cursor: j }], auditioning: false };
    }
  }
  return { mode: "edit", stack: [{ rows: all, cursor: last }], auditioning: false };
}

/** Open the add picker on its first effect. */
export function openAdd(kinds: BoardRow[]): BoardState {
  return { mode: "add", stack: [{ rows: kinds, cursor: 0 }], auditioning: false };
}

/** What landing on `row` does in the preset menu. */
function land(state: BoardState, row: BoardRow | undefined): { state: BoardState; effect?: BoardEffect } {
  if (state.mode !== "edit") return { state };
  if (isPresetRow(row)) return { state: { ...state, auditioning: true }, effect: { t: "audition", row: row! } };
  return state.auditioning ? { state: { ...state, auditioning: false }, effect: { t: "restore" } } : { state };
}

/** BEAT ◀ / ▶. Wraps within the window the highlight is in. */
export function move(s: BoardState, dir: number): { state: BoardState; effect?: BoardEffect } {
  const l = top(s);
  if (!l || !l.rows.length) return { state: s };
  const n = l.rows.length;
  const cursor = (((l.cursor + dir) % n) + n) % n;
  if (cursor === l.cursor) return { state: s };
  const state: BoardState = { ...s, stack: [...s.stack.slice(0, -1), { ...l, cursor }] };
  return land(state, l.rows[cursor]);
}

/** PRESS: go in, or choose. `state: null` = the menu closes. */
export function press(s: BoardState, src: BoardSource): { state: BoardState | null; effect?: BoardEffect } {
  const l = top(s);
  const row = currentRow(s);
  if (!l || !row) return { state: s };
  switch (row.t) {
    case "section": {
      if (!row.items.length) return { state: s };
      const state: BoardState = { ...s, stack: [...s.stack, { rows: row.items, cursor: 0, kind: l.kind }] };
      return land(state, row.items[0]);
    }
    case "kind": {
      const rows = src.kindRows(row.kind);
      if (!rows || !rows.length) return { state: null, effect: { t: "add", kind: row.kind, preset: null } };
      const all = [...rows, DEFAULT];
      // The highlight starts on Default: the plain "just add it" answer is one press away.
      return { state: { ...s, stack: [...s.stack, { rows: all, cursor: all.length - 1, kind: row.kind }] } };
    }
    case "default":
    case "preset":
      if (s.mode === "edit") return { state: null, effect: { t: "keep" } };
      return { state: null, effect: { t: "add", kind: l.kind ?? "", preset: row.t === "preset" ? row.preset : null } };
  }
}

/** SHIFT+BEAT ◀: back one window; at the top, close (undoing an audition). */
export function back(s: BoardState): { state: BoardState | null; effect?: BoardEffect } {
  if (s.stack.length > 1) {
    const state: BoardState = { ...s, stack: s.stack.slice(0, -1) };
    return land(state, currentRow(state)); // back onto the section row: not a preset, so restore
  }
  if (s.mode === "add") return { state: null, effect: { t: "close" } };
  return { state: null, effect: s.auditioning ? { t: "revert" } : { t: "keep" } };
}

/** ◀▶ with the menus closed: the effect tabs, then the ＋ slot, wrapping. `at` = the selected tab
 *  (or `n` for the ＋ slot); `n` tabs; `plus` = whether the ＋ slot exists (there is something
 *  left to add). Returns the new position. */
export function stepTabs(at: number, n: number, plus: boolean, dir: number): number {
  const stops = n + (plus ? 1 : 0);
  if (stops <= 0) return at;
  const from = Math.max(0, Math.min(stops - 1, at));
  return (((from + dir) % stops) + stops) % stops;
}
