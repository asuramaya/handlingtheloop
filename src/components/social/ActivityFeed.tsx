import { useMemo, useState } from "react";
import { follow, groupActivity, type NotifEvent, type NotificationsPayload } from "@htl/account";
import { PersonCardRow, personRel } from "./PersonCardRow";

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
function ago(ms: number): string {
  const m = Math.floor(Math.max(0, Date.now() - ms) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
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

  const followBack = (handle: string) => {
    setFollowedBack((s) => new Set(s).add(handle)); // optimistic — flip to ✓ Following
    void follow(handle);
  };

  // Each event is a PersonCardRow: the person, what they did and when on the meta line, and
  // the answer (Follow back, Join) in the strip with Profile ›.
  const row = (e: NotifEvent, unread: boolean) => {
    const h = e.actor.handle;
    const followsThem = e.followsBack || (!!h && followedBack.has(h));
    return (
      <PersonCardRow
        key={e.id}
        name={actorName(e.actor)}
        avatar={e.actor.avatar}
        rel={personRel({ following: followsThem, followsYou: e.kind === "follow" })}
        meta={`${verb(e.kind)} · ${ago(e.createdAt)}`}
        unread={unread}
        actions={
          e.kind === "invite" && h ? (
            <button className="peer-pill on" onClick={() => onJam(h)}>
              Join
            </button>
          ) : null
        }
        right={
          e.kind === "follow" && h ? (
            followsThem ? (
              <span className="peer-pill static on">Following</span>
            ) : (
              <button className="peer-pill" onClick={() => followBack(h)}>
                Follow back
              </button>
            )
          ) : null
        }
        onProfile={h ? () => onOpenPerson(h) : undefined}
      />
    );
  };

  if (events.length === 0) {
    return (
      <div className="people-empty">
        <span className="people-empty-glyph" aria-hidden="true">🔔</span>
        <b>Nothing yet</b>
        <span>Follows, invites and requests show up here.</span>
        <button className="hw-btn small" onClick={onDiscover}>Find people</button>
      </div>
    );
  }

  return (
    <>
      {/* NEEDS YOU — pinned, ungrouped, never rolled up. Same accent frame as the Session
          screen's waiting list, because it is the same idea: somebody is blocked on you. */}
      {needsYou.length > 0 && (
        <div className="discover-section">
          <div className="social-roster-sep needs">Needs you · {needsYou.length}</div>
          <ul className="social-roster person-list">{needsYou.map((e) => row(e, e.createdAt > seenAt))}</ul>
        </div>
      )}

      {days.map((d) => (
        <div key={d.day} className="discover-section">
          <div className="social-roster-sep">
            {d.label}
            {d.unread > 0 && ` · ${d.unread} new`}
          </div>
          <ul className="social-roster person-list">
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
                  {open && <ul className="notif-list nested social-roster">{r.events.map((e) => row(e, e.createdAt > seenAt))}</ul>}
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
