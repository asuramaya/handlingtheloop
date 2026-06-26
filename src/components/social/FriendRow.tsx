import type { MouseEvent } from "react";
import type { FriendPresence } from "@htl/account";

// One "friend online" row in Discover — the play-with-a-friend door. Avatar + name + a status
// dot, then the actions: Invite pulls them into MY session (push → they get a bell Join), and
// Knock/Join takes ME into THEIRS (jam → pending until they approve, or straight in if they're
// live). Tapping the row (not a button) opens their profile.
export function FriendRow({
  friend: f,
  invited,
  onInvite,
  onJam,
  onOpen,
}: {
  friend: FriendPresence;
  invited: boolean; // optimistic — the Invite was just sent
  onInvite: (handle: string) => void;
  onJam: (handle: string) => void;
  onOpen: (handle: string) => void;
}) {
  const stop = (e: MouseEvent) => e.stopPropagation(); // keep button taps off the row's open-profile
  const invite = (e: MouseEvent) => {
    stop(e);
    onInvite(f.handle);
  };
  const jam = (e: MouseEvent) => {
    stop(e);
    onJam(f.handle);
  };
  return (
    <li className={`friend-row ${f.live ? "live" : ""}`} onClick={() => onOpen(f.handle)}>
      <span className="friend-avatar-wrap">
        {f.avatar ? (
          <img className="live-room-avatar" src={f.avatar} alt="" loading="lazy" />
        ) : (
          <span className="live-room-avatar fallback" aria-hidden="true">
            {(f.displayName || f.handle).slice(0, 1).toUpperCase()}
          </span>
        )}
        <span className={`presence-dot ${f.live ? "live" : "online"}`} aria-hidden="true" />
      </span>
      <span className="live-room-main">
        <span className="live-room-name">{f.displayName || `@${f.handle}`}</span>
        <span className="live-room-np">{f.live ? "live now" : "online"}</span>
      </span>
      <span className="friend-actions">
        {f.live ? (
          <button className="friend-join" onClick={jam}>
            Join
          </button>
        ) : (
          <>
            {invited ? (
              <span className="friend-invited">Invited ✓</span>
            ) : (
              <button className="friend-invite" onClick={invite}>
                Invite
              </button>
            )}
            <button className="friend-knock" onClick={jam}>
              Knock
            </button>
          </>
        )}
      </span>
    </li>
  );
}
