// The People dock's VIEW STATE — where you were, per pane.
//
// ★ WHY IT LIVES OUTSIDE THE COMPONENTS. Every pane is rendered as `{pane === x && <Pane/>}`, so
// switching panes UNMOUNTS one and takes its local state with it: what you had searched, which
// roll-up you had opened, how far you had scrolled. Closing the dock did the same to all of them
// at once. Measured on a 2,000-row fixture: 151 rows and scrollTop 1200 became 51 and 0 on a tab
// hop, and 0 and 0 on a close.
//
// ★ ONE STRIP, FOUR TABS (operator, 2026-11-11: the Session-style redesign). It was two tabs
// (Explore / You) with a pill row under each, which split one choice across two controls. Now it
// is one strip, the same shape as Session: Live (on air and sets, one list of things to hear),
// People (your graph and search), Activity, and a narrow ⚙ for the account. Your own profile is
// not a tab: it is a page pushed from your avatar in the title row, the same way anyone else's
// profile is pushed from a row.
//
// This is deliberately a PLAIN OBJECT of primitives — the row DATA is cached separately in
// peopleCache.ts. View state is small, cheap to hold forever, and safe to restore blindly; data
// is large and has to expire.
export type PeoplePane = "live" | "people" | "activity" | "settings";
export type GraphMode = "following" | "followers";

/** The pushed page that is YOUR profile (editable, with your sets), as opposed to someone's. */
export const ME_PAGE = "\u0000me";

export interface PeopleView {
  pane: PeoplePane;
  /** Pushed person view (a @handle, or ME_PAGE), or null for the pane root. One level is
   *  enough, because a person's page leads back to a list, never deeper. */
  person: string | null;
  listen: { query: string; roomsExpanded: boolean; friendsExpanded: boolean };
  people: { query: string };
  activity: { openRollup: string | null };
  /** Scroll offset per PANE, restored on mount. */
  scroll: Record<PeoplePane, number>;
}

export const INITIAL_PEOPLE_VIEW: PeopleView = {
  pane: "live",
  person: null,
  listen: { query: "", roomsExpanded: false, friendsExpanded: false },
  people: { query: "" },
  activity: { openRollup: null },
  scroll: { live: 0, people: 0, activity: 0, settings: 0 },
};

/** Which pane is showing. */
export function paneOf(v: PeopleView): PeoplePane {
  return v.pane;
}

/** The patch that opens one pane, dropping any pushed person (a caller asking for a destination
 *  means the destination, not a profile stacked over it). */
export function viewForPane(pane: PeoplePane): Partial<PeopleView> {
  return { pane, person: null };
}
