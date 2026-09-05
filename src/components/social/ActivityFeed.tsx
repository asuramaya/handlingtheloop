import { useMemo, useState, type MouseEvent } from "react";
import { follow, groupActivity, type NotifEvent, type NotificationsPayload } from "@htl/account";

// Activity — what happened, and what needs you.
//
// ★ IT WAS A FLAT REVERSE-CHRON LIST and that is the wrong shape under volume: an invite you had
// to answer sat below thirty "X followed you" from five minutes ago. Now the split is by whether
// an event ASKS something of you (see activityGroups.ts), which is the same judgement the Session
// screen's "Waiting on you" makes, applied to the surface with the most ambient traffic.
//
// ★ "Live now" USED TO LIVE HERE TOO — the same LiveRoomRows as the directory, from a second
// poll. It is gone: Discover's ranked list already carries every followed host who is on air, and
// labels them "Friend" / "You follow". Two lists of the same rooms is not two features.
function actorName(a: { handle: string | null; displayName: string | null }): string {
  return a.displayName || (a.handle ? `@${a.handle}` : "Someone");
}

const VERB: Record<string, string> = {
  follow: "followed you",
  mention: "mentioned you in chat",
  invite: "invited you to jam",
  follow_request: "asked to follow you",
  stage_request: "wants to step up to the decks",
  knock: "wants to join your session",
};
const verb = (k: string) => VERB[k] ?? k;

function Avatar({ actor }: { actor: NotifEvent["actor"] }) {
  return actor.avatar ? (
    <img className="live-room-avatar" src={actor.avatar} alt="" loading="lazy" />
  ) : (
    <span className="live-room-avatar fallback" aria-hidden="true">
      {actorName(actor).replace(/^@/, "").slice(0, 1).toUpperCase()}
    </span>
  );
}

export function ActivityFeed({
  data,
  onJam,
  onDiscover,
  onOpenPerson,
  view,
  setView,
}: {
  data: NotificationsPayload;
  onJam: (handle: string) => void;
  onDiscover: () => void; // empty state → the tab that has something in it
  onOpenPerson: (handle: string) => void;
  view: { openRollup: string | null };
  setView: (patch: Partial<{ openRollup: string | null }>) => void;
}) {
  const [followedBack, setFollowedBack] = useState<Set<string>>(new Set());
  // Which roll-up you had opened is part of where you are, so the dock holds it.
  const openRollup = view.openRollup;
  const setOpenRollup = (k: string | null) => setView({ openRollup: k });
  const { events, seenAt } = data;
  const { needsYou, days } = useMemo(() => groupActivity(events, seenAt), [events, seenAt]);

  const followBack = (e: MouseEvent, handle: string) => {
    e.stopPropagation(); // don't trigger the row's go-to-profile
    setFollowedBack((s) => new Set(s).add(handle)); // optimistic — flip to ✓ Following
    void follow(handle);
  };

  const row = (e: NotifEvent, unread: boolean) => (
    <li
      key={e.id}
      className={`notif-item ${unread ? "unread" : ""}`}
      onClick={() => e.actor.handle && onOpenPerson(e.actor.handle)}
    >
      <Avatar actor={e.actor} />
      <span className="notif-text">
        <b>{actorName(e.actor)}</b> {verb(e.kind)}
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
        <button
          className="notif-join"
          onClick={(ev) => {
            ev.stopPropagation();
            onJam(e.actor.handle!);
          }}
        >
          Join
        </button>
      )}
    </li>
  );

  if (events.length === 0) {
    return (
      <div className="activity-empty">
        <p className="settings-note">Nothing yet.</p>
        <button className="hw-btn small" onClick={onDiscover}>Find people</button>
      </div>
    );
  }

  return (
    <>
      {/* NEEDS YOU — pinned, ungrouped, never rolled up. Same accent frame as the Session
          screen's waiting list, because it is the same idea: somebody is blocked on you. */}
      {needsYou.length > 0 && (
        <div className="settings-section waiting-section">
          <div className="settings-section-head">
            <span className="settings-label">Needs you</span>
            <span className="settings-head-note">{needsYou.length}</span>
          </div>
          <ul className="notif-list">{needsYou.map((e) => row(e, e.createdAt > seenAt))}</ul>
        </div>
      )}

      {days.map((d) => (
        <div key={d.day} className="discover-section">
          <div className="social-section-head">
            {d.label}
            {d.unread > 0 && <span className="friends-count"> · {d.unread} new</span>}
          </div>
          <ul className="notif-list">
            {/* ROLL-UPS FIRST: one line for a day's worth of identical news, expandable. Thirty
                "followed you" rows are one fact with a number; keeping them separate is how a
                feed buries the rows that are not. */}
            {d.rollups.map((r) => {
              const key = `${d.day}:${r.kind}`;
              const open = openRollup === key;
              return (
                <li key={key} className="notif-rollup">
                  <button className="notif-rollup-head" onClick={() => setOpenRollup(open ? null : key)}>
                    <span className="notif-rollup-count">{r.count}</span>
                    <span className="notif-text">people {verb(r.kind)}</span>
                    <span className="notif-rollup-caret" aria-hidden="true">{open ? "▾" : "▸"}</span>
                  </button>
                  {open && <ul className="notif-list nested">{r.events.map((e) => row(e, e.createdAt > seenAt))}</ul>}
                </li>
              );
            })}
            {d.events.map((e) => row(e, e.createdAt > seenAt))}
          </ul>
        </div>
      ))}
    </>
  );
}
