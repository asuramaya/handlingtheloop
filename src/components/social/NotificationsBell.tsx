import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import { fetchNotifications, follow, markNotificationsSeen, type NotificationsPayload } from "@htl/account";
import { LiveRoomRow } from "./LiveRoomRow";
import { goToHandle } from "./util";

// The notification bell (Epic I) — a self-contained chin popover. Polls /api/me/notifications
// every 30 s while signed in and shows two sections: "Live now" (people you follow broadcasting
// right now — fan-out-on-read) and "Recent" (the durable event feed, v1 = new followers). The
// unread badge counts anything newer than the server-side `seenAt` cursor (so it's consistent
// across the account's devices); opening the bell stamps the cursor and clears it.

const POLL_MS = 30_000;
const EMPTY: NotificationsPayload = { rooms: [], events: [], seenAt: 0 };

function actorName(a: { handle: string | null; displayName: string | null }): string {
  return a.displayName || (a.handle ? `@${a.handle}` : "Someone");
}

export function NotificationsBell({
  signedIn,
  self,
  tunedTo,
  onListen,
  onJam,
  onSeeAll,
}: {
  signedIn: boolean;
  self: string | null;
  tunedTo: string | null;
  onListen: (handle: string) => void;
  onJam: (handle: string) => void; // accept a jam invite → participate in their session
  onSeeAll: () => void;
}) {
  const [data, setData] = useState<NotificationsPayload>(EMPTY);
  const [open, setOpen] = useState(false);
  const [followedBack, setFollowedBack] = useState<Set<string>>(new Set()); // optimistic follow-back, by handle
  const wrapRef = useRef<HTMLDivElement>(null);

  // Poll while signed in (mirrors Discover's 30 s live-rooms cadence). Signed-out → no bell.
  useEffect(() => {
    if (!signedIn) {
      setData(EMPTY);
      return;
    }
    let alive = true;
    const load = () =>
      fetchNotifications()
        .then((d) => alive && setData(d))
        .catch(() => {});
    load();
    const t = setInterval(load, POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [signedIn]);

  // Close on an outside click or Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const { rooms, events, seenAt } = data;
  const unread =
    rooms.filter((r) => (r.startedAt ?? 0) > seenAt).length + events.filter((e) => e.createdAt > seenAt).length;

  const toggle = useCallback(() => {
    setOpen((v) => {
      const next = !v;
      // Opening = "seen": stamp the cursor server-side (cross-device) + optimistically locally.
      if (next && unread > 0) {
        const ts = Date.now();
        setData((d) => ({ ...d, seenAt: ts }));
        void markNotificationsSeen();
      }
      return next;
    });
  }, [unread]);

  if (!signedIn) return null;

  const tapRoom = (h: string) => {
    onListen(h);
    setOpen(false);
  };
  const tapEvent = (handle: string | null) => {
    if (handle) goToHandle(handle);
    setOpen(false);
  };
  const followBack = (e: MouseEvent, handle: string) => {
    e.stopPropagation(); // don't trigger the row's go-to-profile
    setFollowedBack((s) => new Set(s).add(handle)); // optimistic — flip to ✓ Following
    void follow(handle);
  };
  const acceptJam = (e: MouseEvent, handle: string) => {
    e.stopPropagation(); // don't open their profile — go straight into the session
    onJam(handle);
    setOpen(false);
  };

  return (
    <div className="notif-wrap" ref={wrapRef}>
      <button
        className={`chin-btn chin-notif ${open ? "active" : ""}`}
        onClick={toggle}
        aria-label={unread > 0 ? `Notifications, ${unread} new` : "Notifications"}
        title="Notifications"
      >
        <span className="chin-bell" aria-hidden="true">🔔</span>
        {unread > 0 && <span className="notif-badge">{unread > 9 ? "9+" : unread}</span>}
      </button>

      {open && (
        <div className="notif-pop" role="dialog" aria-label="Notifications">
          {rooms.length === 0 && events.length === 0 ? (
            <p className="notif-empty">No notifications yet. Follow some DJs — you'll hear when they go live.</p>
          ) : (
            <>
              {rooms.length > 0 && (
                <div className="notif-section">
                  <div className="notif-head">● Live now</div>
                  <ul className="live-now-list">
                    {rooms.map((r) => (
                      <LiveRoomRow key={r.handle} room={r} self={self} tunedTo={tunedTo} onTap={tapRoom} />
                    ))}
                  </ul>
                </div>
              )}
              {events.length > 0 && (
                <div className="notif-section">
                  <div className="notif-head">Recent</div>
                  <ul className="notif-list">
                    {events.map((e) => (
                      <li
                        key={e.id}
                        className={`notif-item ${e.createdAt > seenAt ? "unread" : ""}`}
                        onClick={() => tapEvent(e.actor.handle)}
                      >
                        {e.actor.avatar ? (
                          <img className="live-room-avatar" src={e.actor.avatar} alt="" loading="lazy" />
                        ) : (
                          <span className="live-room-avatar fallback" aria-hidden="true">
                            {actorName(e.actor).replace(/^@/, "").slice(0, 1).toUpperCase()}
                          </span>
                        )}
                        <span className="notif-text">
                          <b>{actorName(e.actor)}</b>{" "}
                          {e.kind === "follow"
                            ? "followed you"
                            : e.kind === "mention"
                              ? "mentioned you in chat"
                              : e.kind === "invite"
                                ? "invited you to jam"
                                : e.kind}
                        </span>
                        {e.kind === "follow" &&
                          e.actor.handle &&
                          (e.followsBack || followedBack.has(e.actor.handle) ? (
                            <span className="notif-following">✓ Following</span>
                          ) : (
                            <button className="notif-followback" onClick={(ev) => followBack(ev, e.actor.handle!)}>
                              Follow back
                            </button>
                          ))}
                        {e.kind === "invite" && e.actor.handle && (
                          <button className="notif-join" onClick={(ev) => acceptJam(ev, e.actor.handle!)}>
                            Join
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
          <button
            className="notif-seeall"
            onClick={() => {
              onSeeAll();
              setOpen(false);
            }}
          >
            See all in Discover →
          </button>
        </div>
      )}
    </div>
  );
}
