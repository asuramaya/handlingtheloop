// WHERE YOU WERE IN THE LIST, KEPT ACROSS THE PANEL BEING TORN DOWN.
//
// The library is rendered as `{open && (…)}`, so closing it UNMOUNTS the whole subtree and every
// piece of React state inside dies with it. The handful of things that already survived — which
// tab was open, the sidebar, the collapsed sections — survived only because each was mirrored to
// localStorage by hand. Everything the TRACK TABLE holds was not: the filter you typed, the column
// you sorted by, the cache/stem narrowing, and how far down you had scrolled.
//
// Which is the state that actually costs something to lose. Those are the controls you set up to
// FIND a track, and loading a track is exactly when the panel goes away — so the work of finding
// the next one was thrown out at the precise moment you were about to do it again. "Remember its
// state when closing or changing songs" is that.
//
// KEYED PER LIST, not globally: Collection, Community and each playlist are different lists with
// different lengths, and restoring one's scroll position into another lands you somewhere
// arbitrary. A playlist that is later deleted simply leaves a dead key, which costs a few bytes
// and never misleads anything — its own view is the only reader.

import type { SortKey } from "./trackTable";

export interface TrackTableState {
  sortKey: SortKey;
  sortDir: 1 | -1;
  /** The in-place filter text. Never the SEARCH box's query — that belongs to whoever searched. */
  query: string;
  cacheOnly: boolean;
  stemOnly: boolean;
  scrollTop: number;
}

const PREFIX = "htl:tt:";

export function loadTableState(key: string | undefined): Partial<TrackTableState> {
  if (!key) return {};
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (!raw) return {};
    const v = JSON.parse(raw) as Partial<TrackTableState>;
    // Read each field defensively and INDEPENDENTLY. A blob written by an older build is a partial
    // answer, not a corrupt one, and one unrecognised field must not discard the rest.
    return {
      sortKey: typeof v.sortKey === "string" ? (v.sortKey as SortKey) : undefined,
      sortDir: v.sortDir === -1 ? -1 : v.sortDir === 1 ? 1 : undefined,
      query: typeof v.query === "string" ? v.query : undefined,
      cacheOnly: typeof v.cacheOnly === "boolean" ? v.cacheOnly : undefined,
      stemOnly: typeof v.stemOnly === "boolean" ? v.stemOnly : undefined,
      scrollTop: typeof v.scrollTop === "number" && v.scrollTop >= 0 ? v.scrollTop : undefined,
    };
  } catch {
    return {};
  }
}

export function saveTableState(key: string | undefined, state: TrackTableState): void {
  if (!key) return;
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(state));
  } catch {
    /* private mode / quota — losing the memory is not worth failing a render over */
  }
}
