import type { FriendPresence } from "@htl/account";
import { PersonCardRow } from "./PersonCardRow";

// One "friend online" row — the play-with-a-friend door, as a PersonCardRow. Tap it for the
// strip: Join (they are live) or Knock + Invite, and Profile ›.
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
  return (
    <PersonCardRow
      name={f.displayName || `@${f.handle}`}
      avatar={f.avatar}
      rel="friend"
      meta={[f.displayName ? `@${f.handle}` : null, f.live ? "live now" : "online"].filter(Boolean).join(" · ")}
      presence={f.live ? "live" : "online"}
      actions={
        f.live ? (
          <button className="peer-pill on" onClick={() => onJam(f.handle)}>
            Join
          </button>
        ) : (
          <>
            <button className="peer-pill" onClick={() => onJam(f.handle)} title="Ask to join their session">
              Knock
            </button>
            {invited ? (
              <span className="peer-pill static">Invited ✓</span>
            ) : (
              <button className="peer-pill" onClick={() => onInvite(f.handle)} title="Invite them into your session">
                Invite
              </button>
            )}
          </>
        )
      }
      onProfile={() => onOpen(f.handle)}
    />
  );
}
