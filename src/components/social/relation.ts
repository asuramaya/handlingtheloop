import type { Peer } from "@htl/room/protocol";

// WHO IS THIS TO ME? (operator, 2026-11-11: "color coding would be useful to tell apart same
// account, friends, guests, strangers"). One answer per roster row, viewer-relative, in priority
// order: my own account first, then the session owner, then my friends (mutual follows, matched by
// public @handle), then people who stepped up from the crowd, then everyone else let in.
export type Relation = "you" | "host" | "friend" | "crowd" | "guest";

export function relationOf(p: Peer, me: Peer | null, youId: string, friendHandles: ReadonlySet<string>): Relation {
  if (p.id === youId) return "you";
  if (me && p.host === me.host && (me.host || p.name === me.name)) return "you"; // another device on my account
  if (p.host) return "host";
  if (p.handle && friendHandles.has(p.handle.toLowerCase())) return "friend";
  if (p.stage) return "crowd";
  return "guest";
}

export const RELATION_LABEL: Record<Relation, string> = {
  you: "you",
  host: "host",
  friend: "friend",
  crowd: "crowd",
  guest: "guest",
};
