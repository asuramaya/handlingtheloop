import { useEffect, useState } from "react";
import { type PersonCard, fetchFollowers, fetchFollowing } from "@htl/account";
import { DockResizer } from "../DockResizer";
import { PersonRow } from "./PersonRow";

// The ONE canonical people-list surface — the same place every "browse a graph" entry point
// leads to: a profile's tappable follower/following counts AND Discover's "People you follow".
// Persistent (unlike Friends-online), paginated, and every row is an actionable PersonRow
// (Follow / Knock / Invite / Listen) with a presence dot — so the list isn't just a directory
// you tab through, you act from it. onJam/onListen are optional: supplied in the Discover context
// (the room is in hand), omitted from the profile-counts context (rows degrade to tap-through).
export function PeopleList({
  handle,
  mode,
  onClose,
  onJam,
  onListen,
}: {
  handle: string; // whose graph we're listing
  mode: "followers" | "following";
  onClose: () => void;
  onJam?: (handle: string) => void;
  onListen?: (handle: string) => void;
}) {
  const [list, setList] = useState<PersonCard[] | null>(null); // null = loading
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let alive = true;
    const fetcher = mode === "followers" ? fetchFollowers : fetchFollowing;
    fetcher(handle, 0)
      .then((p) => {
        if (!alive) return;
        setList(p.list);
        setMore(p.more);
      })
      .catch(() => alive && setList([]));
    return () => {
      alive = false;
    };
  }, [handle, mode]);

  const loadMore = () => {
    if (loading || !list) return;
    setLoading(true);
    const fetcher = mode === "followers" ? fetchFollowers : fetchFollowing;
    fetcher(handle, list.length)
      .then((p) => {
        setList((prev) => [...(prev ?? []), ...p.list]);
        setMore(p.more);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  };

  const title = mode === "followers" ? "Followers" : "Following";
  const emptyMsg =
    mode === "followers" ? `@${handle} has no followers yet.` : `@${handle} isn't following anyone yet.`;

  return (
    <div className="modal-backdrop dock-right" onPointerDown={onClose}>
      <DockResizer varName="--dock-w-right" measure="parent" />
      <div className="panel people-list-screen" onPointerDown={(e) => e.stopPropagation()}>
        <div className="discover-head">
          <span className="discover-title">
            {title} <span className="people-list-of">· @{handle}</span>
          </span>
          <button className="profile-x" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        {list === null ? (
          <p className="discover-empty">Loading…</p>
        ) : list.length === 0 ? (
          <p className="discover-empty">{emptyMsg}</p>
        ) : (
          <ul className="person-search-results" role="list">
            {list.map((c) => (
              <PersonRow key={c.handle} card={c} onJam={onJam} onListen={onListen} />
            ))}
            {more && (
              <li className="person-more">
                <button className="person-more-btn" onClick={loadMore} disabled={loading}>
                  {loading ? "Loading…" : "Load more"}
                </button>
              </li>
            )}
          </ul>
        )}
      </div>
    </div>
  );
}
