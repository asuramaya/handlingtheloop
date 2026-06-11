// The Search modal's contents persist across close/open and page reloads, so a
// dig-session survives — same query, results, filter and sort when you reopen it.
// (Transient bits — the in-flight request, errors — are NOT persisted.)
import { Store } from "../persistence";
import type { TrackMeta } from "../library/types";

export type SortKey = "relevance" | "title" | "artist" | "duration" | "views";

export interface SearchState {
  query: string;
  results: TrackMeta[];
  searched: boolean;
  filter: string;
  sort: SortKey;
}

const DEFAULT_SEARCH: SearchState = {
  query: "",
  results: [],
  searched: false,
  filter: "",
  sort: "relevance",
};

const store = new Store<SearchState>("search", DEFAULT_SEARCH, 1);

export function loadSearchState(): SearchState {
  return store.get();
}

export function saveSearchState(s: SearchState): void {
  store.set(s);
}
