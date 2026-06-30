import { type MouseEvent, useState } from "react";
import { type PersonCard, follow, sendInvite, unfollow } from "@htl/account";
import { goToHandle } from "./util";

// One ACTIONABLE person row — shared by search results, follower/following lists, and
// suggestions. Avatar + presence dot + name, then the one right action for the relationship:
//   • not following → Follow / Follow back        (direct fetch, no room)
//   • following, not mutual → Following (untoggle) (direct fetch)
//   • mutual + live → Join  · mutual + online → Knock   (needs onJam — the room)
//   • mutual (any) → Invite                         (pull them to MY session; direct fetch)
//   • non-mutual + live → Listen                    (needs onListen)
// Follow + Invite work everywhere (plain fetch); Knock/Join/Listen need the room handlers and
// degrade to a row tap-through (open the profile) when those aren't supplied (e.g. profile counts).
export function PersonRow({
  card,
  onJam,
  onListen,
}: {
  card: PersonCard;
  onJam?: (handle: string) => void; // knock / join a friend's session (needs the room)
  onListen?: (handle: string) => void; // tune into a public live set
}) {
  const [following, setFollowing] = useState(card.following);
  const [invited, setInvited] = useState(false);
  const [busy, setBusy] = useState(false);
  const h = card.handle ?? "";
  const mutual = following && card.followsYou;

  const stop = (e: MouseEvent) => e.stopPropagation();
  const toggleFollow = async (e: MouseEvent) => {
    stop(e);
    if (busy || !h) return;
    setBusy(true);
    const next = !following;
    setFollowing(next); // optimistic
    const ok = await (next ? follow(h) : unfollow(h)); // both return {...}|null (null = failed)
    if (!ok) setFollowing(!next); // revert in EITHER direction on failure
    setBusy(false);
  };
  const invite = (e: MouseEvent) => {
    stop(e);
    if (!h || invited) return;
    setInvited(true); // optimistic
    void sendInvite(h).then((ok) => {
      if (!ok) setInvited(false); // revert so a failed invite can be retried
    });
  };
  const jam = (e: MouseEvent) => {
    stop(e);
    if (h) onJam?.(h);
  };
  const listen = (e: MouseEvent) => {
    stop(e);
    if (h) onListen?.(h);
  };

  return (
    <li className={`person-row ${card.live ? "live" : ""}`} onClick={() => h && goToHandle(h)}>
      <span className="person-avatar-wrap">
        {card.avatar ? (
          <img className="live-room-avatar" src={card.avatar} alt="" loading="lazy" />
        ) : (
          <span className="live-room-avatar fallback" aria-hidden="true">
            {(card.displayName || h || "?").slice(0, 1).toUpperCase()}
          </span>
        )}
        {(card.live || card.online) && (
          <span className={`presence-dot ${card.live ? "live" : "online"}`} aria-hidden="true" />
        )}
      </span>
      <span className="live-room-main">
        <span className="live-room-name">{card.displayName || `@${h}`}</span>
        <span className="live-room-np">
          {card.live ? "live now" : card.online ? "online" : card.followsYou && !following ? "follows you" : `@${h}`}
        </span>
      </span>
      <span className="person-actions" onClick={stop}>
        {card.isSelf ? (
          <span className="person-you">You</span>
        ) : mutual ? (
          <>
            {card.live && onJam ? (
              <button className="friend-join" onClick={jam}>
                Join
              </button>
            ) : card.online && onJam ? (
              <button className="friend-knock" onClick={jam}>
                Knock
              </button>
            ) : null}
            {invited ? (
              <span className="friend-invited">Invited ✓</span>
            ) : (
              <button className="friend-invite" onClick={invite}>
                Invite
              </button>
            )}
          </>
        ) : (
          <>
            {card.live && onListen && (
              <button className="friend-join" onClick={listen}>
                Listen
              </button>
            )}
            <button className={`follow-btn ${following ? "on" : ""}`} onClick={toggleFollow} disabled={busy}>
              {following ? "Following" : card.followsYou ? "Follow back" : "Follow"}
            </button>
          </>
        )}
      </span>
    </li>
  );
}
