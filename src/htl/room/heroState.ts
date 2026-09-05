// The Session screen's ONE state — extracted from the component so it can be tested, which is
// the whole reason it stopped being three inline ternaries.
//
// ★ ORDER IS THE DESIGN. These are not independent flags to be checked in any convenient
// sequence; they are a priority list, and the priority IS the product decision:
//   offline   — the socket is down, so nothing else you could read is current. Saying "LIVE"
//               over a dead connection is worse than saying nothing.
//   pending   — you are held at the door. What you COULD be doing is irrelevant until someone
//               lets you in.
//   listening — you are in someone else's room; their broadcast is the fact about this screen.
//   live      — you are broadcasting. The primary action is ending it.
//   idle      — signed in, nothing happening, so the primary action is starting something.
//   none      — a guest with no session: there is no state to report and no action to offer.
export type HeroState = "offline" | "pending" | "listening" | "live" | "idle" | "none";

export interface HeroInputs {
  online: boolean;
  pending: boolean;
  listeningTo: string | null;
  broadcasting: boolean;
  isGuest: boolean;
  signedIn: boolean;
}

export function heroState(s: HeroInputs): HeroState {
  if (!s.online) return "offline";
  if (s.pending) return "pending";
  if (s.listeningTo) return "listening";
  if (s.broadcasting) return "live";
  if (!s.isGuest && s.signedIn) return "idle";
  return "none";
}
