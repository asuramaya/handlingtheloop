import { describe, expect, it } from "vitest";
import type { DockMode, PanelKey } from "./settings";
import {
  SHEET_Z,
  edgeZIndex,
  isResizable,
  panelZIndex,
  panelsToClose,
  placementDim,
  placementFor,
  placementsFor,
  type PanelPlacement,
} from "./panelPlacement";

const ALL: PanelKey[] = ["library", "settings", "people", "session"];
const MODES: DockMode[] = ["left", "right", "center", "bottom"];

// The configuration this repo's own operator has saved, which is what made the bug reachable:
// three panels centered, one on the bottom, and the backdrop dim turned all the way down.
const OPERATOR_DOCKS: Record<PanelKey, DockMode> = {
  library: "bottom",
  settings: "center",
  people: "center",
  session: "center",
};

describe("placementFor", () => {
  it("hands every desktop configuration straight back", () => {
    for (const m of MODES) expect(placementFor(m, false)).toBe(m);
  });

  it("collapses EVERY configuration to a sheet on a phone", () => {
    for (const m of MODES) expect(placementFor(m, true)).toBe("sheet");
  });

  // ★ THE CASE THAT PROVES THE OLD BEHAVIOUR WAS BROKEN.
  //
  // The stylesheet used to answer this question itself, and only wrote phone rules for
  // `.dock-left` and `.dock-right`. So "center" and "bottom" fell through to the generic
  // floating-card backdrop. This asserts the two modes that had NO phone rule are exactly the
  // ones that must not survive the trip — a test written against the old code would have to
  // assert `placementFor("center", true) === "center"`, and that assertion is the bug.
  it("does not let the two modes the old CSS forgot reach a phone", () => {
    expect(placementFor("center", true)).not.toBe("center");
    expect(placementFor("bottom", true)).not.toBe("bottom");
  });

  it("resolves the operator's own saved config to four sheets", () => {
    const p = placementsFor(OPERATOR_DOCKS, true);
    expect(Object.values(p)).toEqual(["sheet", "sheet", "sheet", "sheet"]);
  });

  it("leaves that same config untouched on a desktop", () => {
    expect(placementsFor(OPERATOR_DOCKS, false)).toEqual(OPERATOR_DOCKS);
  });
});

describe("panelsToClose", () => {
  it("evicts every other panel on a phone — there is one slot", () => {
    const p = placementsFor(OPERATOR_DOCKS, true);
    for (const key of ALL) {
      expect(panelsToClose(key, p).sort()).toEqual(ALL.filter((k) => k !== key).sort());
    }
  });

  // The phone rule must not leak the other way: on a desktop two edge docks are supported
  // stacking, not a collision, and closing one to open the other would be a regression.
  it("closes nothing when edge docks coexist on a desktop", () => {
    const p = placementsFor({ library: "left", settings: "right", people: "left", session: "bottom" }, false);
    for (const key of ALL) expect(panelsToClose(key, p)).toEqual([]);
  });

  it("closes only the other CENTER panels, never the edge ones", () => {
    const p: Record<PanelKey, PanelPlacement> = {
      library: "center",
      settings: "center",
      people: "left",
      session: "bottom",
    };
    expect(panelsToClose("library", p)).toEqual(["settings"]);
    expect(panelsToClose("people", p)).toEqual([]);
  });

  it("never asks a panel to close itself", () => {
    const p = placementsFor(OPERATOR_DOCKS, true);
    for (const key of ALL) expect(panelsToClose(key, p)).not.toContain(key);
  });
});

describe("the sheet answers the questions a phone should not be asked", () => {
  it("is not resizable", () => {
    expect(isResizable("sheet")).toBe(false);
    for (const m of MODES) expect(isResizable(m)).toBe(true);
  });

  it("dims nothing, whatever the user configured", () => {
    expect(placementDim("sheet", 0.55)).toBe(0);
    expect(placementDim("sheet", 1)).toBe(0);
    expect(placementDim("center", 0.55)).toBe(0.55);
  });

  it("takes the base modal z-index instead of consulting panelOrder", () => {
    const order: PanelKey[] = ["session", "settings", "library", "people"];
    expect(panelZIndex("sheet", "people", order, 77)).toBe(SHEET_Z);
    // …and the ranking a sheet ignores is real, so this is a choice and not a coincidence:
    expect(edgeZIndex("session", order)).toBeGreaterThan(edgeZIndex("people", order));
    expect(panelZIndex("left", "people", order, 77)).toBe(edgeZIndex("people", order));
    expect(panelZIndex("center", "people", order, 77)).toBe(77);
  });

  it("keeps an unranked panel above the board rather than below it", () => {
    expect(edgeZIndex("people", ["session"] as PanelKey[])).toBeGreaterThanOrEqual(40);
  });
});
