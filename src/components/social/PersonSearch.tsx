import { useEffect, useRef, useState } from "react";
import { type PersonCard, fetchSuggested, searchUsers } from "@htl/account";
import { PersonRow } from "./PersonRow";

// The directory door at the top of Discover — find ANYONE by @handle or name, even when nobody's
// live. Debounced global search with paginated results (Load more); each row is an actionable
// PersonRow (Follow / Knock / Invite / Listen). When the box is empty it shows "People you may
// know" (friends-of-friends, or popular accounts cold-start) so discovery isn't a blank prompt.
export function PersonSearch({
  onJam,
  onListen,
}: {
  onJam?: (handle: string) => void;
  onListen?: (handle: string) => void;
}) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<PersonCard[] | null>(null); // null = idle (no active query)
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [suggested, setSuggested] = useState<PersonCard[] | null>(null);
  const offset = useRef(0);

  // "People you may know" — fetched once for the idle state.
  useEffect(() => {
    const ctrl = new AbortController();
    fetchSuggested(ctrl.signal)
      .then(setSuggested)
      .catch(() => {});
    return () => ctrl.abort();
  }, []);

  // Debounced page-0 search on every keystroke.
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setResults(null);
      setMore(false);
      setLoading(false);
      return;
    }
    setLoading(true);
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      offset.current = 0;
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
    };
  }, [q]);

  const loadMore = () => {
    const term = q.trim();
    if (term.length < 2 || loading) return;
    setLoading(true);
    offset.current += 20;
    searchUsers(term, offset.current)
      .then((p) => {
        setResults((prev) => [...(prev ?? []), ...p.list]);
        setMore(p.more);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  };

  const idle = results === null;
  const rows = idle ? (suggested ?? []) : results;

  return (
    <div className="person-search">
      <input
        className="person-search-input"
        type="search"
        placeholder="Search people — @handle or name"
        aria-label="Search people by handle or name"
        maxLength={40}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
      />

      {idle && rows.length > 0 && <div className="person-search-label">People you may know</div>}

      {rows.length > 0 ? (
        <ul className="person-search-results" role="list">
          {rows.map((c) => (
            <PersonRow key={c.handle} card={c} onJam={onJam} onListen={onListen} />
          ))}
          {!idle && more && (
            <li className="person-more">
              <button className="person-more-btn" onClick={loadMore} disabled={loading}>
                {loading ? "Loading…" : "Load more"}
              </button>
            </li>
          )}
        </ul>
      ) : idle ? null : loading ? null : (
        <p className="person-search-empty">No one matches "{q.trim()}".</p>
      )}
    </div>
  );
}
