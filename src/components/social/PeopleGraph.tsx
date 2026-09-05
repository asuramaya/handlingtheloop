import { useEffect, useMemo, useRef, useState } from "react";
import { type GraphMode, type PersonCard, fetchFollowers, fetchFollowing, readGraph, writeGraph } from "@htl/account";
import { PersonRow } from "./PersonRow";
import { PersonSearch } from "./PersonSearch";
import { StickyRange } from "./StickyRange";

// PEOPLE — your graph, as a first-class tab.
//
// ★ IT WAS THE DEEPEST-BURIED SURFACE IN THE APP, and it is the one that scales hardest. Live
// rooms scale with who happens to be broadcasting; your graph only ever grows. Yet reaching it
// meant a small "People you follow ›" text link inside the Discover tab, which opened a modal
// with its own dock backdrop and its own DockResizer ON TOP of the People dock: a modal, over a
// tab, in a dock, with two resizers driving the same CSS variable. It is a face of the Explore
// fold now, one pill away from what is on air.
//
// ★ AND IT HAD NO SEARCH. It paged 50 at a time behind "Load more", so finding one person in a
// 2,000-follow graph was forty presses. A list you can only walk is not a list you can use.
// Filtering is client-side over what has been LOADED, and says so — silently filtering a window
// of a paginated list while implying you searched the whole graph is worse than not offering it,
// so the empty state names the gap and points at the global search that does hit the server.
// Below this many loaded rows the whole list fits on a screen or two and the filter is noise.
const FILTER_FLOOR = 10;

export function PeopleGraph({
  self,
  onJam,
  onListen,
  onOpenPerson,
  view,
  setView,
}: {
  self: string | null;
  onJam: (handle: string) => void;
  onListen: (handle: string) => void;
  onOpenPerson: (handle: string) => void;
  view: { mode: GraphMode; query: string };
  setView: (patch: Partial<{ mode: GraphMode; query: string }>) => void;
}) {
  // Mode and query are the DOCK's, not this component's — it unmounts on every tab switch and
  // would take them with it. The rows are the dock's too, by way of peopleCache.
  const { mode, query: q } = view;
  const setMode = (m: GraphMode) => setView({ mode: m });
  const setQ = (query: string) => setView({ query });
  const [list, setList] = useState<PersonCard[] | null>(() => (self ? readGraph(self, mode)?.list ?? null : null));
  const [more, setMore] = useState(() => (self ? readGraph(self, mode)?.more ?? false : false));
  const [loading, setLoading] = useState(false);
  // ★ RESET ON MOUNT, not just on unmount. `useRef(true)` + a cleanup that sets it false is the
  // classic broken form: under StrictMode React mounts, unmounts and REMOUNTS the same instance,
  // and a ref survives that — so the cleanup latched `false` permanently and every later
  // `if (!mounted.current) return` bailed. The visible symptom was "Load more" sticking on
  // "Loading…" forever and issuing no further request, because setLoading(false) was the thing
  // being skipped. Found by paging a 2,000-row graph fixture; it had been latent in this
  // component's original form the whole time.
  const listRef = useRef<HTMLUListElement | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!self) {
      setList([]);
      return;
    }
    // ★ SERVE THE CACHE FIRST, and do not re-fetch behind it. Coming back to a tab you had paged
    // three deep should show those 150 rows immediately — showing a spinner over data you
    // already have is the flicker that makes a list feel like it resets every time you look away.
    const hit = readGraph(self, mode);
    if (hit) {
      setList(hit.list);
      setMore(hit.more);
      return;
    }
    let alive = true;
    setList(null);
    const fetcher = mode === "followers" ? fetchFollowers : fetchFollowing;
    fetcher(self, 0)
      .then((p) => {
        if (!alive) return;
        setList(p.list);
        setMore(p.more);
        writeGraph(self, mode, p.list, p.more);
      })
      .catch(() => alive && setList([]));
    return () => {
      alive = false;
    };
  }, [self, mode]);

  const loadMore = () => {
    if (loading || !list || !self) return;
    setLoading(true);
    const fetcher = mode === "followers" ? fetchFollowers : fetchFollowing;
    fetcher(self, list.length)
      .then((p) => {
        if (!mounted.current) return;
        setList((prev) => {
          const next = [...(prev ?? []), ...p.list];
          writeGraph(self, mode, next, p.more); // the cache holds the WHOLE paged run, not page 1
          return next;
        });
        setMore(p.more);
        setLoading(false);
      })
      .catch(() => mounted.current && setLoading(false));
  };

  // MUTUALS FIRST, then people who are reachable right now. A graph list is for REACHING people,
  // so the ones you can actually reach belong at the top; alphabetical would be a filing cabinet.
  const ranked = useMemo(() => {
    const rows = list ?? [];
    const score = (c: PersonCard) =>
      (c.following && c.followsYou ? 4 : 0) + (c.live ? 2 : 0) + (c.online ? 1 : 0);
    return [...rows].sort(
      (a, b) => score(b) - score(a) || (a.displayName || a.handle || "").localeCompare(b.displayName || b.handle || ""),
    );
  }, [list]);

  // ★ A HIDDEN FILTER MUST NOT STILL BE FILTERING. Switching from a side with 200 loaded to one
  // with 3 takes the input off screen; if the query kept applying you would be looking at an
  // unexplained empty list with no control to clear it.
  const showFilter = (list?.length ?? 0) > FILTER_FLOOR;
  const shown = useMemo(() => {
    const needle = showFilter ? q.trim().toLowerCase() : "";
    if (!needle) return ranked;
    return ranked.filter((c) =>
      [c.handle, c.displayName].filter(Boolean).some((v) => String(v).toLowerCase().includes(needle)),
    );
  }, [ranked, q, showFilter]);

  if (!self) {
    return <p className="settings-note">Sign in to see your people.</p>;
  }

  return (
    <>
      {/* The GLOBAL search stays on top: it hits the server and finds anyone, follower or not. */}
      <PersonSearch onJam={onJam} onListen={onListen} />

      {/* The two sides of the graph, in the same pill grammar as the fold above but one level
          in: which face of People, not which face of the dock. It was a labelled settings row
          ("Show: Following | Followers"), which read as a preference rather than a place. */}
      <div className="people-subfaces" role="tablist" aria-label="Graph side">
        <button
          role="tab"
          aria-selected={mode === "following"}
          className={`face-pill sub ${mode === "following" ? "on" : ""}`}
          onClick={() => setMode("following")}
        >
          Following
        </button>
        <button
          role="tab"
          aria-selected={mode === "followers"}
          className={`face-pill sub ${mode === "followers" ? "on" : ""}`}
          onClick={() => setMode("followers")}
        >
          Followers
        </button>
      </div>

      {/* The local filter only appears once there is enough loaded for it to do anything. Below
          that it was a second empty box under the global search box, offering to narrow a list
          you can already see all of. */}
      {showFilter && (
        <div className="discover-filter">
          <input
            className="debug-filter discover-query"
            value={q}
            placeholder={`Filter ${list?.length ?? 0} loaded`}
            aria-label="Filter loaded people"
            onChange={(e) => setQ(e.target.value)}
          />
          {q && <button className="link-btn" onClick={() => setQ("")}>Clear</button>}
        </div>
      )}

      <div className="discover-section">
        <StickyRange
          label={mode === "following" ? "Following" : "Followers"}
          loaded={shown.length}
          total={showFilter && q ? shown.length : list ? list.length : undefined}
          listRef={listRef}
          hasMore={more && !(showFilter && q)}
        />
        {list === null ? (
          <p className="discover-empty">Loading…</p>
        ) : list.length === 0 ? (
          <p className="discover-empty">
            {mode === "following" ? "You aren't following anyone yet." : "No followers yet."}
          </p>
        ) : shown.length === 0 ? (
          // ★ SAY WHAT WAS SEARCHED. The filter only sees what is loaded, so an empty result on a
          // partially-paged graph must not read as "this person does not exist".
          <p className="discover-empty">
            No match in the {list.length} loaded. Search above to find anyone.
          </p>
        ) : (
          <ul className="person-search-results" role="list" ref={listRef}>
            {shown.map((c, i) => (
              <PersonRow key={c.handle ?? `i${i}`} card={c} onJam={onJam} onListen={onListen} onOpen={onOpenPerson} />
            ))}
            {more && !(showFilter && q) && (
              <li className="person-more">
                <button className="person-more-btn" onClick={loadMore} disabled={loading}>
                  {loading ? "Loading…" : "Load more"}
                </button>
              </li>
            )}
          </ul>
        )}
      </div>
    </>
  );
}
