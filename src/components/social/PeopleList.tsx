import { useEffect, useState } from "react";
import { type FollowCard, fetchFollowers, fetchFollowing } from "@htl/account";
import { DockResizer } from "../DockResizer";
import { goToHandle } from "./util";

// The ONE canonical people-list surface — the same place every "browse a graph" entry point
// leads to: a profile's tappable follower/following counts AND Discover's "People you follow".
// Persistent (unlike Friends-online), so you can reach anyone you follow whether or not they're
// on right now. A row taps through to /@handle, where the full action set already lives
// (Follow / Invite / Knock / Listen) — so this stays a pure directory, no per-row presence.
export function PeopleList({
  handle,
  mode,
  onClose,
}: {
  handle: string; // whose graph we're listing
  mode: "followers" | "following";
  onClose: () => void;
}) {
  const [list, setList] = useState<FollowCard[] | null>(null); // null = loading

  useEffect(() => {
    let alive = true;
    const fetcher = mode === "followers" ? fetchFollowers : fetchFollowing;
    fetcher(handle)
      .then((l) => alive && setList(l))
      .catch(() => alive && setList([]));
    return () => {
      alive = false;
    };
  }, [handle, mode]);

  const open = (h: string | null) => {
    if (!h) return;
    onClose(); // drop the modal first — goToHandle re-points the profile underneath
    goToHandle(h);
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
          <ul className="person-search-results">
            {list.map((p) => (
              <li key={p.handle ?? p.displayName} className="person-row" onClick={() => open(p.handle)}>
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
        )}
      </div>
    </div>
  );
}
