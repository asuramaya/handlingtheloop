import { type KeyboardEvent, type ReactNode, useState } from "react";

// ONE ROW FOR EVERY PERSON in the People dock: live rooms, friends online, your graph, search
// results, follow requests and activity. (Operator, 2026-11-11: the People tab gets the Session
// panel's redesign.) It is the Session roster's row: an avatar, the name, a coloured tag for who
// they are to you, and one meta line; a folded row has no controls. Tapping it opens a strip with
// what you can do (Listen, Join, Knock, Invite, Approve…) on the left and Follow plus "Profile ›"
// on the right. Five row styles with inline buttons (which crammed a phone) became this one.
export type PersonRel = "you" | "friend" | "following" | "follower" | "other";

export const PERSON_REL_LABEL: Record<PersonRel, string | null> = {
  you: "You",
  friend: "Friend",
  following: "Following",
  follower: "Follows you",
  other: null,
};

/** Who someone is to you, from the follow edges a card carries. */
export function personRel(c: { isSelf?: boolean; following?: boolean; followsYou?: boolean }): PersonRel {
  if (c.isSelf) return "you";
  if (c.following && c.followsYou) return "friend";
  if (c.following) return "following";
  if (c.followsYou) return "follower";
  return "other";
}

export function PersonCardRow({
  name,
  avatar,
  rel,
  meta,
  presence,
  badge,
  actions,
  right,
  onProfile,
  unread,
}: {
  name: string;
  avatar: string | null;
  rel: PersonRel;
  meta?: ReactNode;
  /** A dot on the avatar: on air, or online. */
  presence?: "live" | "online" | null;
  /** Extra tags beside the name (Live, Just started…). */
  badge?: ReactNode;
  /** The strip's left side: what you can do with them. */
  actions?: ReactNode;
  /** The strip's right side, before "Profile ›" (Follow / Following). */
  right?: ReactNode;
  onProfile?: () => void;
  /** Activity: newer than your read cursor. */
  unread?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const toggle = () => setOpen((o) => !o);
  const label = PERSON_REL_LABEL[rel];
  return (
    <li className={`social-card person-card rel-${rel} in can-open ${open ? "open" : ""} ${unread ? "unread" : ""}`}>
      <span className="social-card-ico person-card-ava" aria-hidden="true">
        {avatar ? <img src={avatar} alt="" loading="lazy" /> : <span>{name.replace(/^@/, "").slice(0, 1).toUpperCase() || "?"}</span>}
        {presence && <span className={`presence-dot ${presence}`} />}
      </span>
      <div
        className="social-card-main"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={toggle}
        onKeyDown={(e: KeyboardEvent) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            toggle();
          }
        }}
      >
        <div className="social-card-top">
          <span className="social-card-name">{name}</span>
          {label && <span className={`rel-tag ${rel}`}>{label}</span>}
          {badge}
        </div>
        {meta && <div className="social-card-meta">{meta}</div>}
      </div>
      {open && (
        <div className="social-card-drop">
          <span className="social-card-drop-main">{actions}</span>
          <span className="social-card-drop-side">
            {right}
            {onProfile && (
              <button className="peer-pill" onClick={onProfile}>
                Profile ›
              </button>
            )}
          </span>
        </div>
      )}
    </li>
  );
}
