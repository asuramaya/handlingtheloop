import { type MouseEvent, useEffect, useState } from "react";
import { type PersonCard, fetchFollowRequests, respondFollowRequest } from "@htl/account";
import { goToHandle } from "./util";

// The private-account approval inbox — pending people who asked to follow you. Approve moves them
// into your followers; deny silently drops the request. Renders nothing when there are none, so it
// can be mounted unconditionally on your own profile. Tapping a row opens that person's profile.
export function FollowRequests() {
  const [list, setList] = useState<PersonCard[] | null>(null); // null = loading

  useEffect(() => {
    let alive = true;
    fetchFollowRequests()
      .then((r) => alive && setList(r.list))
      .catch(() => alive && setList([]));
    return () => {
      alive = false;
    };
  }, []);

  const respond = (e: MouseEvent, handle: string | null, approve: boolean) => {
    e.stopPropagation();
    if (!handle) return;
    setList((l) => (l ?? []).filter((c) => c.handle !== handle)); // optimistic remove
    void respondFollowRequest(handle, approve);
  };

  if (!list || list.length === 0) return null;
  return (
    <div className="profile-section">
      <div className="profile-section-head">
        Follow requests <span className="friends-count">· {list.length}</span>
      </div>
      <ul className="person-search-results" role="list">
        {list.map((c) => (
          <li key={c.handle} className="person-row" onClick={() => c.handle && goToHandle(c.handle)}>
            {c.avatar ? (
              <img className="live-room-avatar" src={c.avatar} alt="" loading="lazy" />
            ) : (
              <span className="live-room-avatar fallback" aria-hidden="true">
                {(c.displayName || c.handle || "?").slice(0, 1).toUpperCase()}
              </span>
            )}
            <span className="live-room-main">
              <span className="live-room-name">{c.displayName || `@${c.handle}`}</span>
              <span className="live-room-np">wants to follow you</span>
            </span>
            <span className="person-actions" onClick={(e) => e.stopPropagation()}>
              <button className="friend-join" onClick={(e) => respond(e, c.handle, true)}>
                Approve
              </button>
              <button className="friend-knock" onClick={(e) => respond(e, c.handle, false)}>
                Deny
              </button>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
