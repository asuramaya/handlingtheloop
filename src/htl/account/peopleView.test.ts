import { describe, expect, it } from "vitest";
import { INITIAL_PEOPLE_VIEW, PANE_TAB, type PeoplePane, paneOf, viewForPane } from "./peopleView";

const PANES: PeoplePane[] = ["air", "sets", "people", "profile", "activity"];

describe("peopleView folds", () => {
  it("every pane has a scroll slot", () => {
    for (const p of PANES) expect(INITIAL_PEOPLE_VIEW.scroll[p]).toBe(0);
  });

  it("viewForPane lands on that pane, whatever the previous view was", () => {
    for (const p of PANES) {
      const v = { ...INITIAL_PEOPLE_VIEW, ...viewForPane(p) };
      expect(v.tab).toBe(PANE_TAB[p]);
      expect(paneOf(v)).toBe(p);
    }
  });

  it("drops a pushed person", () => {
    const v = { ...INITIAL_PEOPLE_VIEW, person: "dj", ...viewForPane("activity") };
    expect(v.person).toBeNull();
  });

  // The whole point of remembering both faces: coming back to a fold restores the face you left,
  // not the fold's default. A single `face` field would have made a tab hop a reset.
  it("keeps the other fold's face while switching tabs", () => {
    let v = { ...INITIAL_PEOPLE_VIEW, ...viewForPane("people") };
    v = { ...v, ...viewForPane("activity") };
    expect(v.explore).toBe("people");
    v = { ...v, ...viewForPane("air") };
    expect(v.you).toBe("activity");
    expect(paneOf(v)).toBe("air");
  });
});
