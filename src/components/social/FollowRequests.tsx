import { useEffect, useState } from "react";
import { type PersonCard, fetchFollowRequests, respondFollowRequest } from "@htl/account";
import { PersonCardRow, personRel } from "./PersonCardRow";
import { goToHandle } from "./util";

// The private-account approval inbox — pending people who asked to follow you. Approve moves them
// into your followers; deny silently drops the request. Renders nothing when there are none, so it
// can be mounted unconditionally at the top of the People tab.
let requestsMemo: PersonCard[] | null = null; // kept across mounts: no section dropping in late

export function FollowRequests({ onOpen }: { onOpen?: (handle: string) => void }) {
  const [list, setListState] = useState<PersonCard[] | null>(requestsMemo); // null = loading
  const setList = (v: PersonCard[] | null | ((p: PersonCard[] | null) => PersonCard[] | null)) =>
    setListState((prev) => {
      const next = typeof v === "function" ? v(prev) : v;
      requestsMemo = next;
      return next;
    });

  useEffect(() => {
    let alive = true;
    fetchFollowRequests()
      .then((r) => alive && setList(r.list))
      .catch(() => alive && setList([]));
    return () => {
      alive = false;
    };
  }, []);

  const respond = (handle: string | null, approve: boolean) => {
    if (!handle) return;
    setList((l) => (l ?? []).filter((c) => c.handle !== handle)); // optimistic remove
    void respondFollowRequest(handle, approve);
  };

  if (!list || list.length === 0) return null;
  return (
    <div className="discover-section">
      <div className="social-roster-sep">Requests · {list.length}</div>
      <ul className="social-roster person-list" role="list">
        {list.map((c) => (
          <PersonCardRow
            key={c.handle}
            name={c.displayName || `@${c.handle}`}
            avatar={c.avatar}
            rel={personRel(c)}
            meta="wants to follow you"
            actions={
              <>
                <button className="peer-pill on" onClick={() => respond(c.handle, true)}>
                  Approve
                </button>
                <button className="peer-pill" onClick={() => respond(c.handle, false)}>
                  Deny
                </button>
              </>
            }
            onProfile={c.handle ? () => (onOpen ? onOpen(c.handle!) : goToHandle(c.handle!)) : undefined}
          />
        ))}
      </ul>
    </div>
  );
}
