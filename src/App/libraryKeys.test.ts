import { describe, expect, it } from "vitest";
import { libraryKeyAction } from "./libraryKeys";

describe("library keys", () => {
  it("while the Library is open: arrows browse, ← / → pick sources / tracks, Enter loads", () => {
    expect(libraryKeyAction("ArrowDown", false, true)).toEqual({ kind: "browse", delta: 1 });
    expect(libraryKeyAction("ArrowUp", false, true)).toEqual({ kind: "browse", delta: -1 });
    expect(libraryKeyAction("ArrowLeft", false, true)).toEqual({ kind: "sources", on: true });
    expect(libraryKeyAction("ArrowRight", false, true)).toEqual({ kind: "sources", on: false });
    expect(libraryKeyAction("Enter", false, true)).toEqual({ kind: "load", toOther: false });
    expect(libraryKeyAction("Enter", true, true)).toEqual({ kind: "load", toOther: true });
  });
  it("CONTROL: closed, every key is the board's again (arrows jog, Enter does nothing here)", () => {
    for (const c of ["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Enter"]) expect(libraryKeyAction(c, false, false)).toBeNull();
  });
  it("CONTROL: board keys are never taken, open or not", () => {
    expect(libraryKeyAction("Space", false, true)).toBeNull();
    expect(libraryKeyAction("KeyQ", false, true)).toBeNull();
  });
});
