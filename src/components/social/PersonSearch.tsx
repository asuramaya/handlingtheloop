import { useEffect, useState } from "react";
import { type FollowCard, searchUsers } from "@htl/account";
import { goToHandle } from "./util";

// The directory door at the top of Discover — find ANYONE by @handle or name, even when nobody's
// live. Debounced global search; a result taps straight through to /@handle, where the full action
// set already lives (Follow / Invite / Knock / Listen). Idle (under 2 chars) shows nothing but the
// box; this is a deliberate lookup, not an ambient feed.
export function PersonSearch() {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<FollowCard[] | null>(null); // null = idle (no active query)
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setResults(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      searchUsers(term, ctrl.signal)
        .then((list) => {
          setResults(list);
          setLoading(false);
        })
        .catch(() => {
          /* aborted by the next keystroke — keep the prior list, the new query owns the state */
        });
    }, 250);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [q]);

  return (
    <div className="person-search">
      <input
        className="person-search-input"
        type="search"
        placeholder="Search people — @handle or name"
        maxLength={40}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
      />
      {results !== null && (results.length > 0 ? (
        <ul className="person-search-results">
          {results.map((p) => (
            <li
              key={p.handle ?? p.displayName}
              className="person-row"
              onClick={() => p.handle && goToHandle(p.handle)}
            >
              {p.avatar ? (
                <img className="live-room-avatar" src={p.avatar} alt="" loading="lazy" />
              ) : (
                <span className="live-room-avatar fallback" aria-hidden="true">
                  {(p.displayName || p.handle || "?").slice(0, 1).toUpperCase()}
                </span>
              )}
              <span className="live-room-main">
                <span className="live-room-name">{p.displayName || `@${p.handle}`}</span>
                {p.displayName && p.handle && <span className="live-room-np">@{p.handle}</span>}
              </span>
              <span className="person-go" aria-hidden="true">›</span>
            </li>
          ))}
        </ul>
      ) : loading ? null : (
        <p className="person-search-empty">No one matches "{q.trim()}".</p>
      ))}
    </div>
  );
}
