import { type KeyboardEvent, type ReactNode } from "react";

// ONE ROW FOR EVERY PERSON in the People dock: live rooms, friends online, your graph, search
// results, follow requests, activity, and a profile's follower lists. An avatar, the name, a
// coloured tag for who they are to you, and one meta line.
//
// ★ A PERSON ROW OPENS THE PERSON (operator, 2026-11-12: the folded-out strip "is a bit
// wasteful, does not look good and does not serve the same purpose as the rows in session").
// A Session row unfolds because it carries switches (Decks, Sound, Remove) and nothing to open;
// a person row's real destination is their profile. So tapping the row opens it, and the one or
// two things worth doing without going there (Follow, Join, Listen, Approve…) sit as small pills
// at the row's right edge. The strip and its "Profile ›" are gone.
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
  onProfile,
  unread,
}: {
  name: string;
  avatar: string | null;
  rel: PersonRel;
  meta?: ReactNode;
  /** A dot on the avatar: on air, or online. */
  presence?: "live" | "online" | null;
  /** Extra tags beside the name (Just started, tuned in…). */
  badge?: ReactNode;
  /** The row's own quick actions, small pills at its right edge (one or two at most). */
  actions?: ReactNode;
  /** Tapping the row opens this person. */
  onProfile?: () => void;
  /** Activity: newer than your read cursor. */
  unread?: boolean;
}) {
  const label = PERSON_REL_LABEL[rel];
  const open = onProfile;
  return (
    <li className={`social-card person-card rel-${rel} in ${open ? "can-open" : ""} ${unread ? "unread" : ""}`}>
      <span className="social-card-ico person-card-ava" aria-hidden="true">
        {avatar ? <img src={avatar} alt="" loading="lazy" /> : <span>{name.replace(/^@/, "").slice(0, 1).toUpperCase() || "?"}</span>}
        {presence && <span className={`presence-dot ${presence}`} />}
      </span>
      <div
        className="social-card-main"
        {...(open
          ? {
              role: "button",
              tabIndex: 0,
              title: "Open profile",
              onClick: open,
              onKeyDown: (e: KeyboardEvent) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  open();
                }
              },
            }
          : {})}
      >
        <div className="social-card-top">
          <span className="social-card-name">{name}</span>
          {label && <span className={`rel-tag ${rel}`}>{label}</span>}
          {badge}
        </div>
        {meta && <div className="social-card-meta">{meta}</div>}
      </div>
      {actions && <span className="person-card-acts">{actions}</span>}
    </li>
  );
}
