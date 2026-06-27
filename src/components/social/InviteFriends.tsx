import { useEffect, useState } from "react";
import { type FriendPresence, fetchFriendsOnline, sendInvite } from "@htl/account";

// Direct-invite a friend to YOUR session from the session console — the targeted counterpart to
// "Go live" (an audience) and the anon co-DJ link. Works the same whether you're private or live:
// the invite is one notification ("come to my session"); the LANDING adapts (private → they jam
// your booth; live → they drop into the set and can step up). One fetch on mount, no poll — this
// is a deliberate action, not an ambient surface.
export function InviteFriends({ live }: { live: boolean }) {
  const [friends, setFriends] = useState<FriendPresence[] | null>(null); // null = loading
  const [invited, setInvited] = useState<Set<string>>(new Set());

  useEffect(() => {
    let alive = true;
    fetchFriendsOnline()
      .then((f) => alive && setFriends(f))
      .catch(() => alive && setFriends([]));
    return () => {
      alive = false;
    };
  }, []);

  const invite = (handle: string) => {
    setInvited((s) => new Set(s).add(handle)); // optimistic
    void sendInvite(handle);
  };

  if (friends === null) return <p className="invite-friends-empty">Checking who's around…</p>;
  if (friends.length === 0)
    return <p className="invite-friends-empty">No friends online right now — they'll show here when they're on.</p>;

  return (
    <>
      <span className="share-mode-sub">
        {live
          ? "They drop straight into your live set and can step up to the decks."
          : "They join your session — no link, no approval needed once they tap."}
      </span>
      <ul className="invite-friends-list">
        {friends.map((f) => (
          <li key={f.handle} className="invite-friend-row">
            {f.avatar ? (
              <img className="live-room-avatar" src={f.avatar} alt="" loading="lazy" />
            ) : (
              <span className="live-room-avatar fallback" aria-hidden="true">
                {(f.displayName || f.handle).slice(0, 1).toUpperCase()}
              </span>
            )}
            <span className="live-room-main">
              <span className="live-room-name">{f.displayName || `@${f.handle}`}</span>
              <span className="live-room-np">{f.live ? "live now" : "online"}</span>
            </span>
            {invited.has(f.handle) ? (
              <span className="friend-invited">Invited ✓</span>
            ) : (
              <button className="friend-invite" onClick={() => invite(f.handle)}>
                Invite
              </button>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}
