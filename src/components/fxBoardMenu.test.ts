import { describe, expect, it } from "vitest";
import { back, currentRow, move, openBoard, point, press, top, type BoardRow, type BoardSource } from "./fxBoardMenu";

// The FX SELECT board menu grammar: PRESS = in / choose, SHIFT+PRESS = back / close, ◀▶ = move.
const P = (name: string): BoardRow => ({ t: "preset", preset: { name, params: { x: 1 } } });
const ROWS: BoardRow[] = [P("Wide"), { t: "section", name: "Dub", items: [P("Dub A"), P("Dub B")] }, P("Tight")];
const SRC: BoardSource = {
  addList: () => [{ t: "kind", kind: "reverb", label: "REVERB" }, { t: "kind", kind: "gate", label: "GATE" }],
  kindRows: () => [{ t: "default" }, P("Hall")],
};
// top level = Default, Wide, Dub▸, Tight, ＋ Add, ✕ Remove
const open = (active = "") => openBoard("DELAY", "delay", ROWS, active);

describe("FX SELECT board menu", () => {
  it("opens on the selected effect with the highlight on the preset in use", () => {
    expect(currentRow(open())).toEqual({ t: "default" });
    expect(currentRow(open("Tight"))).toEqual(P("Tight"));
    expect(top(open()).rows.map((r) => r.t)).toEqual(["default", "preset", "section", "preset", "add", "remove"]);
  });

  it("◀▶ wrap, and landing on a preset auditions it (sections and acts do not)", () => {
    let s = open();
    let r = move(s, -1); // wraps to ✕ Remove
    expect(currentRow(r.state)?.t).toBe("remove");
    expect(r.effect).toBeUndefined();
    s = open();
    r = move(s, 1); // → Wide
    expect(r.effect).toEqual({ t: "audition", row: P("Wide") });
    r = move(r.state, 1); // → Dub (a section): leaving the presets undoes the audition
    expect(r.effect).toEqual({ t: "restore" });
    r = move(r.state, 1); // → Tight
    expect(r.effect).toEqual({ t: "audition", row: P("Tight") });
  });

  // ★ operator, 2026-11-08: cycling past an ungrouped preset onto the next row left it "stuck on
  // that mode" — it now goes back to the state the menu opened on.
  it("cycling past the presets onto ＋ Add / ✕ Remove restores the opening state, once", () => {
    let r = move(open("Tight"), -1); // Tight → Dub▸: nothing auditioned yet, nothing to restore
    expect(r.effect).toBeUndefined();
    r = move(open(), 3); // Default → Tight
    expect(r.effect).toEqual({ t: "audition", row: P("Tight") });
    r = move(r.state, 1); // → ＋ Add
    expect(r.effect).toEqual({ t: "restore" });
    r = move(r.state, 1); // → ✕ Remove: already restored
    expect(r.effect).toBeUndefined();
    r = move(r.state, 1); // wraps → Default: auditioned again
    expect(r.effect).toEqual({ t: "audition", row: { t: "default" } });
  });

  it("backing out of a section after auditioning inside it restores the opening state", () => {
    let s = move(move(open(), 1).state, 1).state; // on Dub▸ (Wide was auditioned, then restored)
    s = press(s, SRC).state!;
    const r = move(s, 1); // → Dub B
    expect(r.effect).toEqual({ t: "audition", row: P("Dub B") });
    expect(back(r.state).effect).toEqual({ t: "restore" });
  });

  it("PRESS drills into a section; on a preset it keeps it and closes", () => {
    let s = move(move(open(), 1).state, 1).state; // on Dub▸
    s = press(s, SRC).state!;
    expect(top(s).title).toBe("Dub");
    expect(press(s, SRC)).toEqual({ state: null, effect: { t: "keep" } });
  });

  it("SHIFT+PRESS goes back a level, and at the top closes with a revert", () => {
    let s = move(move(open(), 1).state, 1).state;
    s = press(s, SRC).state!; // in Dub
    s = back(s).state!;
    expect(top(s).title).toBe("DELAY");
    expect(back(s)).toEqual({ state: null, effect: { t: "revert" } });
  });

  it("＋ Add effect → the effect list → its presets (Default first) → adds it", () => {
    let s = move(open(), -2).state; // ＋ Add
    s = press(s, SRC).state!;
    expect(top(s).title).toBe("Add effect");
    s = move(s, 1).state; // GATE
    s = press(s, SRC).state!;
    expect(currentRow(s)).toEqual({ t: "default" });
    expect(move(s, 1).effect).toBeUndefined(); // a not-yet-added effect is never auditioned
    expect(press(s, SRC)).toEqual({ state: null, effect: { t: "add", kind: "gate", preset: null } });
    expect(press(move(s, 1).state, SRC).effect).toEqual({ t: "add", kind: "gate", preset: { name: "Hall", params: { x: 1 } } });
  });

  it("✕ Remove needs a second press; moving or going back cancels the confirm", () => {
    let s = move(open(), -1).state; // ✕ Remove
    s = press(s, SRC).state!;
    expect(s.confirmRemove).toBe(true);
    expect(press(s, SRC)).toEqual({ state: null, effect: { t: "remove" } });
    expect(move(s, 1).state.confirmRemove).toBe(false);
    const b = back(s);
    expect(b.state?.confirmRemove).toBe(false); // back first just cancels the pending remove
    expect(b.effect).toBeUndefined();
  });

  it("the mouse points the same highlight without auditioning", () => {
    const s = point(open(), 3);
    expect(currentRow(s)).toEqual(P("Tight"));
  });
});
