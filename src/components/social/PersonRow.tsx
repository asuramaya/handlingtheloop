import { useState } from "react";
import { type PersonCard, follow, sendInvite, unfollow, withdrawFollowRequest } from "@htl/account";
import { PersonCardRow, personRel } from "./PersonCardRow";
import { goToHandle } from "./util";

// One ACTIONABLE person row — shared by search results, the People tab's sections, a profile's
// follower / following lists and suggestions. It is a PersonCardRow: the row opens the profile,
// and the pills at its edge are the right move for the relationship:
//   • a friend (mutual): Join (live) · Knock (online) · else Invite
//   • anyone else: Listen when they are live, and Follow / Follow back / Following / Requested
// A follow or unfollow announces itself ("htl:graph") so the People tab's sections re-read.
export const GRAPH_CHANGED = "htl:graph";
export function PersonRow({
  card,
  onJam,
  onListen,
  onOpen,
  meta,
}: {
  card: PersonCard;
  onJam?: (handle: string) => void; // knock / join a friend's session (needs the room)
  onListen?: (handle: string) => void; // tune into a public live set
  // PUSH this person inside the dock instead of routing to /@handle. Falls back to the route
  // when absent (a profile-counts list outside the dock has nowhere to push to).
  onOpen?: (handle: string) => void;
  /** Override the meta line (e.g. "wants to follow you"). */
  meta?: string;
}) {
  const [following, setFollowing] = useState(card.following);
  const [requested, setRequested] = useState(false); // pending request to a private account
  const [invited, setInvited] = useState(false);
  const [busy, setBusy] = useState(false);
  const h = card.handle ?? "";
  const mutual = following && card.followsYou;

  const toggleFollow = async () => {
    if (busy || !h) return;
    setBusy(true);
    const next = !following;
    setFollowing(next); // optimistic
    const res = await (next ? follow(h) : unfollow(h)); // both return {relationship,counts}|null
    if (!res) setFollowing(!next); // revert in EITHER direction on failure
    else if (next && res.relationship?.requested) {
      setFollowing(false); // a private account → a pending request, not an edge
      setRequested(true);
    } else window.dispatchEvent(new Event(GRAPH_CHANGED));
    setBusy(false);
  };
  const invite = () => {
    if (!h || invited) return;
    setInvited(true); // optimistic
    void sendInvite(h).then((ok) => {
      if (!ok) setInvited(false); // revert so a failed invite can be retried
    });
  };
  const withdraw = () => {
    if (!h) return;
    setRequested(false); // optimistic
    void withdrawFollowRequest(h);
  };

  const rel = personRel({ isSelf: card.isSelf, following, followsYou: card.followsYou });
  const status = card.live ? "live now" : card.online ? "online" : null;
  const metaLine = meta ?? ([card.displayName && h ? `@${h}` : null, status].filter(Boolean).join(" · ") || null);

  const actions = card.isSelf ? null : mutual ? (
    card.live && onJam ? (
      <button className="peer-pill on" onClick={() => onJam(h)}>
        Join
      </button>
    ) : card.online && onJam ? (
      <button className="peer-pill" onClick={() => onJam(h)} title="Ask to join their session">
        Knock
      </button>
    ) : invited ? (
      <span className="peer-pill static">Invited ✓</span>
    ) : (
      <button className="peer-pill" onClick={invite} title="Invite them into your session">
        Invite
      </button>
    )
  ) : (
    <>
      {card.live && onListen && (
        <button className="peer-pill on" onClick={() => onListen(h)}>
          🎧 Listen
        </button>
      )}
      {requested ? (
        <button className="peer-pill" onClick={withdraw} title="Withdraw the request">
          Requested ✕
        </button>
      ) : (
        <button className={`peer-pill ${following ? "on" : ""}`} onClick={() => void toggleFollow()} disabled={busy} aria-pressed={following}>
          {following ? "Following" : card.followsYou ? "Follow back" : "Follow"}
        </button>
      )}
    </>
  );

  return (
    <PersonCardRow
      name={card.displayName || (h ? `@${h}` : "Someone")}
      avatar={card.avatar}
      rel={rel}
      meta={metaLine}
      presence={card.live ? "live" : card.online ? "online" : null}
      actions={actions}
      onProfile={h ? () => (onOpen ? onOpen(h) : goToHandle(h)) : undefined}
    />
  );
}
