import { describe, expect, it } from "vitest";
import { INITIAL_PEOPLE_VIEW, type PeoplePane, paneOf, viewForPane } from "./peopleView";

const PANES: PeoplePane[] = ["live", "people", "activity", "settings"];

describe("peopleView", () => {
  it("every pane has a scroll slot", () => {
    for (const p of PANES) expect(INITIAL_PEOPLE_VIEW.scroll[p]).toBe(0);
  });

  it("viewForPane lands on that pane, whatever the previous view was", () => {
    for (const p of PANES) {
      const v = { ...INITIAL_PEOPLE_VIEW, ...viewForPane(p) };
      expect(paneOf(v)).toBe(p);
    }
  });

  it("drops a pushed person", () => {
    const v = { ...INITIAL_PEOPLE_VIEW, person: "dj", ...viewForPane("activity") };
    expect(v.person).toBeNull();
  });

  it("keeps each pane's own state across a tab hop", () => {
    let v = { ...INITIAL_PEOPLE_VIEW, people: { query: "ab" }, ...viewForPane("people") };
    v = { ...v, ...viewForPane("activity") };
    v = { ...v, ...viewForPane("people") };
    expect(v.people.query).toBe("ab");
  });
});
