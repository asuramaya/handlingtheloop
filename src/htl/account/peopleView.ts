// The People dock's VIEW STATE — where you were, per pane.
//
// ★ WHY IT LIVES OUTSIDE THE COMPONENTS. Every pane is rendered as `{pane === x && <Pane/>}`, so
// switching panes UNMOUNTS one and takes its local state with it: which side of the graph you
// were reading, what you had filtered, which roll-up you had opened, how far you had scrolled.
// Closing the dock did the same to all of them at once. Measured on a 2,000-row fixture: 151 rows
// and scrollTop 1200 became 51 and 0 on a tab hop, and 0 and 0 on a close.
//
// ★ TWO TABS, FIVE PANES. It was four flat tabs (Listen / People / Activity / You) and they were
// not four peers: Listen and People are both "browse other people" and each already carried its
// OWN segmented control inside the body (On air|Sets, Following|Followers), so the strip and the
// segment below it were doing the same job one row apart. Activity and You are both "mine". So
// the strip folds to the two things you are actually choosing between — everyone else, or you —
// and the in-body segments are promoted into the fold's own pill row. Same five destinations,
// one control instead of three.
//
// This is deliberately a PLAIN OBJECT of primitives — the row DATA is cached separately in
// peopleCache.ts. View state is small, cheap to hold forever, and safe to restore blindly; data
// is large and has to expire.
export type PeopleTab = "explore" | "you";
export type ExploreFace = "air" | "sets" | "people";
export type YouFace = "profile" | "activity";
/** One destination. Flat, because that is what a caller ("open People on Activity") means. */
export type PeoplePane = ExploreFace | YouFace;
/** Discover's own half of the Explore fold — it never renders the People face. */
export type ListenFace = "air" | "sets";
export type GraphMode = "following" | "followers";

export const PANE_TAB: Record<PeoplePane, PeopleTab> = {
  air: "explore",
  sets: "explore",
  people: "explore",
  profile: "you",
  activity: "you",
};

export interface PeopleView {
  tab: PeopleTab;
  /** The open face of each fold, remembered independently so hopping tabs is not a reset. */
  explore: ExploreFace;
  you: YouFace;
  /** Pushed person view, or null for the pane root. The dock's whole nav stack — one level is
   *  enough, because a person's page leads back to a list, never deeper. */
  person: string | null;
  listen: { query: string; roomsExpanded: boolean; friendsExpanded: boolean };
  people: { mode: GraphMode; query: string };
  activity: { openRollup: string | null };
  /** Scroll offset per PANE, restored on mount. Keyed by pane and not by tab because the two
   *  faces of a fold render entirely different lists. */
  scroll: Record<PeoplePane, number>;
}

export const INITIAL_PEOPLE_VIEW: PeopleView = {
  tab: "you",
  explore: "air",
  you: "profile",
  person: null,
  listen: { query: "", roomsExpanded: false, friendsExpanded: false },
  people: { mode: "following", query: "" },
  activity: { openRollup: null },
  scroll: { air: 0, sets: 0, people: 0, profile: 0, activity: 0 },
};

/** Which pane is showing. */
export function paneOf(v: PeopleView): PeoplePane {
  return v.tab === "explore" ? v.explore : v.you;
}

/** The patch that opens one pane — sets the tab AND the fold's face, and drops any pushed person
 *  (a caller asking for a destination means the destination, not a profile stacked over it). */
export function viewForPane(pane: PeoplePane): Partial<PeopleView> {
  const tab = PANE_TAB[pane];
  return tab === "explore"
    ? { tab, explore: pane as ExploreFace, person: null }
    : { tab, you: pane as YouFace, person: null };
}
