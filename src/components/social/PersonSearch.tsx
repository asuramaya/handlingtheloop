import { type ReactNode, useEffect, useRef, useState } from "react";
import { type PersonCard, fetchSuggested, searchUsers } from "@htl/account";
import { PersonRow } from "./PersonRow";

// The directory door: find ANYONE by @handle or name, even when nobody is live. Debounced global
// search with paginated results (Load more); each row is a PersonRow. While the box is empty it
// shows `children` (the People tab's own sections) and then "People you may know"
// (friends-of-friends, or popular accounts cold-start) so discovery is not a blank prompt.
let suggestedMemo: PersonCard[] | null = null; // kept across mounts: no list dropping in late

export function PersonSearch({
  q,
  setQ,
  onJam,
  onListen,
  onOpen,
  exclude,
  children,
}: {
  q: string;
  setQ: (q: string) => void;
  onJam?: (handle: string) => void;
  onListen?: (handle: string) => void;
  onOpen?: (handle: string) => void;
  /** Handles already shown in the sections above; "People you may know" skips them. */
  exclude?: ReadonlySet<string>;
  children?: ReactNode;
}) {
  const [results, setResults] = useState<PersonCard[] | null>(null); // null = idle (no active query)
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [suggested, setSuggested] = useState<PersonCard[] | null>(suggestedMemo);
  const offset = useRef(0);
  const activeTerm = useRef(""); // the query currently OWNING the result state
  const moreCtrl = useRef<AbortController | null>(null); // in-flight Load-more (cancel on new query/unmount)

  // "People you may know" — fetched once for the idle state.
  useEffect(() => {
    const ctrl = new AbortController();
    fetchSuggested(ctrl.signal)
      .then((l) => {
        suggestedMemo = l;
        setSuggested(l);
      })
      .catch(() => {});
    return () => ctrl.abort();
  }, []);

  // Debounced page-0 search on every keystroke. Each new query claims `activeTerm` and cancels any
  // in-flight Load-more, so a stale page-1 can't splice into a different query's results.
  useEffect(() => {
    const term = q.trim();
    moreCtrl.current?.abort(); // a keystroke supersedes any pending Load-more
    if (term.length < 2) {
      activeTerm.current = "";
      setResults(null);
      setMore(false);
      setLoading(false);
      return;
    }
    setLoading(true);
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      offset.current = 0;
      activeTerm.current = term;
      searchUsers(term, 0, ctrl.signal)
        .then((p) => {
          setResults(p.list);
          setMore(p.more);
          setLoading(false);
        })
        .catch(() => {
          /* superseded by the next keystroke — that query owns the state */
        });
    }, 250);
    return () => {
      clearTimeout(t);
      ctrl.abort();
      moreCtrl.current?.abort();
    };
  }, [q]);

  const loadMore = () => {
    const term = q.trim();
    if (term.length < 2 || loading) return;
    setLoading(true);
    offset.current += 20;
    const ctrl = new AbortController();
    moreCtrl.current = ctrl;
    searchUsers(term, offset.current, ctrl.signal)
      .then((p) => {
        if (activeTerm.current !== term) return; // the query changed mid-flight → discard this page
        setResults((prev) => [...(prev ?? []), ...p.list]);
        setMore(p.more);
        setLoading(false);
      })
      .catch(() => {
        if (activeTerm.current === term) setLoading(false); // ignore aborts from a superseding query
      });
  };

  const idle = q.trim().length < 2;
  const rows = (idle ? (suggested ?? []).filter((c) => !c.isSelf && !(c.handle && exclude?.has(c.handle))) : results) ?? [];

  return (
    <>
      <div className="discover-filter">
        <input
          className="debug-filter discover-query person-search-input"
          type="search"
          placeholder="Search people by @handle or name"
          aria-label="Search people by handle or name"
          maxLength={40}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
        />
      </div>

      {idle && children}

      {rows.length > 0 ? (
        <div className="discover-section">
          <div className="social-roster-sep">{idle ? "People you may know" : "Results"}</div>
          <ul className="social-roster person-list" role="list">
            {rows.map((c, i) => (
              <PersonRow key={c.handle ?? `i${i}`} card={c} onJam={onJam} onListen={onListen} onOpen={onOpen} />
            ))}
          </ul>
          {!idle && more && (
            <button className="link-btn discover-more" onClick={loadMore} disabled={loading}>
              {loading ? "Loading…" : "Load more"}
            </button>
          )}
        </div>
      ) : idle || loading || results === null ? null : (
        <p className="discover-empty">No one matches “{q.trim()}”.</p>
      )}
    </>
  );
}
