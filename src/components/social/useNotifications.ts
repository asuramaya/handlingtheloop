import { useCallback, useEffect, useState } from "react";
import { fetchNotifications, markNotificationsSeen, type NotificationsPayload } from "@htl/account";

// The notification poll, lifted OUT of the bell component.
//
// ★ WHY IT MOVED. The badge has to be live while the panel is CLOSED — that is the entire job of
// a badge — so the poll cannot belong to the thing it opens. It used to, because the bell was
// both the badge and the popover; splitting them means the count keeps ticking whether or not
// anyone is looking at the feed, and the feed becomes a plain render of data someone else owns.
const POLL_MS = 30_000;
const EMPTY: NotificationsPayload = { rooms: [], events: [], seenAt: 0 };

export interface Notifications {
  data: NotificationsPayload;
  unread: number;
  /** Stamp the server-side cursor (so it is consistent across the account's devices) and clear
   *  the badge optimistically. Called when the Activity tab is actually shown, not when the
   *  panel opens — landing on Discover must not silently mark unseen things seen. */
  markSeen: () => void;
}

export function useNotifications(signedIn: boolean): Notifications {
  const [data, setData] = useState<NotificationsPayload>(EMPTY);

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

  const { rooms, events, seenAt } = data;
  const unread =
    rooms.filter((r) => (r.startedAt ?? 0) > seenAt).length + events.filter((e) => e.createdAt > seenAt).length;

  const markSeen = useCallback(() => {
    if (unread <= 0) return;
    const ts = Date.now();
    setData((d) => ({ ...d, seenAt: ts }));
    void markNotificationsSeen();
  }, [unread]);

  return { data, unread, markSeen };
}
