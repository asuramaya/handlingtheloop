import { describe, expect, it } from "vitest";
import { back, currentRow, move, openAdd, openEdit, press, stepTabs, top, type BoardRow, type BoardSource } from "./fxBoardMenu";

// The FX SELECT board cursor over the SAME menus the mouse opens (operator, 2026-11-08: "making the
// menus the same even the flyovers so there is not two menus").
const P = (name: string, at: number): BoardRow => ({ t: "preset", at, preset: { name, params: { x: 1 } } });
// the preset menu renders: Wide, Dub▸ (Dub A, Dub B), Tight — then Default pinned in the chin
const ROWS: BoardRow[] = [P("Wide", 0), { t: "section", at: 1, name: "Dub", items: [P("Dub A", 0), P("Dub B", 1)] }, P("Tight", 2)];
const DEF = { t: "default", at: -1 };
const SRC: BoardSource = { kindRows: (k) => (k === "gate" ? null : [P("Hall", 0), { t: "section", at: 1, name: "Rooms", items: [P("Small", 0)] }]) };
const KINDS: BoardRow[] = [{ t: "kind", at: 0, kind: "reverb" }, { t: "kind", at: 1, kind: "gate" }];

describe("FX SELECT board cursor — the preset menu", () => {
  it("opens on the preset in use: top level, inside its section, or Default in the chin", () => {
    expect(currentRow(openEdit(ROWS, "Tight"))).toEqual(P("Tight", 2));
    const inSection = openEdit(ROWS, "Dub B");
    expect(inSection.stack.length).toBe(2);
    expect(currentRow(inSection)).toEqual(P("Dub B", 1));
    expect(currentRow(openEdit(ROWS, ""))).toEqual(DEF);
    expect(top(openEdit(ROWS, "")).rows.map((r) => r.t)).toEqual(["preset", "section", "preset", "default"]);
  });

  it("◀▶ wrap; landing on a preset auditions it, landing on a section restores the opening state", () => {
    let r = move(openEdit(ROWS, ""), 1); // Default wraps → Wide
    expect(r.effect).toEqual({ t: "audition", row: P("Wide", 0) });
    r = move(r.state, 1); // → Dub▸
    expect(r.effect).toEqual({ t: "restore" });
    r = move(r.state, 1); // → Tight
    expect(r.effect).toEqual({ t: "audition", row: P("Tight", 2) });
    r = move(r.state, 1); // → Default (also auditions: it is a state)
    expect(r.effect).toEqual({ t: "audition", row: DEF });
  });

  it("PRESS on a section enters its flyout (auditioning the first preset); PRESS on a preset keeps and closes", () => {
    let s = move(move(openEdit(ROWS, ""), 1).state, 1).state; // on Dub▸
    const r = press(s, SRC);
    expect(r.effect).toEqual({ t: "audition", row: P("Dub A", 0) });
    s = r.state!;
    expect(top(s).rows).toEqual(ROWS[1].t === "section" ? ROWS[1].items : []);
    expect(press(s, SRC)).toEqual({ state: null, effect: { t: "keep" } });
  });

  it("SHIFT+◀ backs out of a flyout (restoring), and at the top closes with a revert only if something was auditioned", () => {
    let s = move(move(openEdit(ROWS, ""), 1).state, 1).state;
    s = press(s, SRC).state!; // in Dub, Dub A auditioned
    const b = back(s);
    expect(b.effect).toEqual({ t: "restore" });
    expect(currentRow(b.state!)?.t).toBe("section");
    expect(back(b.state!)).toEqual({ state: null, effect: { t: "keep" } });
    const aud = move(openEdit(ROWS, ""), 1).state; // Wide auditioned
    expect(back(aud)).toEqual({ state: null, effect: { t: "revert" } });
  });
});

describe("FX SELECT board cursor — the ＋ add picker", () => {
  it("PRESS on an effect opens its preset flyout on Default; PRESS adds with that preset", () => {
    let s = openAdd(KINDS);
    expect(currentRow(s)).toEqual(KINDS[0]);
    expect(move(s, 1).effect).toBeUndefined(); // the picker never auditions
    s = press(s, SRC).state!;
    expect(currentRow(s)).toEqual(DEF);
    expect(press(s, SRC)).toEqual({ state: null, effect: { t: "add", kind: "reverb", preset: null } });
    s = move(s, 1).state; // wraps → Hall
    expect(press(s, SRC)).toEqual({ state: null, effect: { t: "add", kind: "reverb", preset: { name: "Hall", params: { x: 1 } } } });
  });

  it("a section inside the flyout opens too, and still adds the flyout's effect", () => {
    let s = press(openAdd(KINDS), SRC).state!;
    s = move(s, -1).state; // Default → Rooms▸
    s = press(s, SRC).state!;
    expect(press(s, SRC)).toEqual({ state: null, effect: { t: "add", kind: "reverb", preset: { name: "Small", params: { x: 1 } } } });
  });

  it("an effect with no presets adds straight away; back at the top just closes", () => {
    const s = move(openAdd(KINDS), 1).state; // gate
    expect(press(s, SRC)).toEqual({ state: null, effect: { t: "add", kind: "gate", preset: null } });
    expect(back(openAdd(KINDS))).toEqual({ state: null, effect: { t: "close" } });
  });
});

describe("FX SELECT board cursor — the tabs, with the ＋ as one more stop", () => {
  it("steps tabs then ＋, wrapping both ways; no ＋ when there is nothing to add", () => {
    expect(stepTabs(2, 3, true, 1)).toBe(3); // last tab → ＋
    expect(stepTabs(3, 3, true, 1)).toBe(0); // ＋ → first tab
    expect(stepTabs(0, 3, true, -1)).toBe(3); // first tab ← ＋
    expect(stepTabs(2, 3, false, 1)).toBe(0); // no ＋: wraps tab to tab
  });
});
