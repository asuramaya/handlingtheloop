import type { ChatMsg } from "./protocol";

// FOLDING THE SERVER'S CHAT BACKLOG INTO WHAT THIS DEVICE ALREADY HAS.
//
// ★ IT USED TO BE A REPLACE, AND THE REPLACE LOSES LINES FOR A REASON UNRELATED TO CHAT.
// `chatHistory: (list) => setChatLog(list)` in useRoom. The server sends `chat-history` from TWO
// places (server/room.ts:481 and :982): on every socket accept, and on every `request-state`.
// `request-state` is a routine RESYNC — the watchdog fires it when a tick goes stale, a path
// sessionSim.test.ts exercises deliberately — so it is not a reconnect-only event. A device that has
// been in the room a while holds up to 120 live lines; the server's backlog is 30 (Chat.HISTORY).
// So an unrelated resync silently drops 90 lines of the conversation the person was reading.
//
// Those two numbers are NOT a limit duplicated across a wire, which is the first thing I checked:
// 30 is the backlog a joiner is given, 120 is what this device keeps for display. They answer
// different questions and are allowed to differ. The defect is the fold, not the caps.
//
// ★ AND THE NAIVE FIX IS WRONG IN A WAY THE REPLACE IS NOT, which is the whole reason this is a
// module rather than a one-line edit. Ids are `c${seq}` from a counter that lives in the Durable
// Object's memory (server/roomCrowd.ts). A DO restart resets it, so a NEW `c1` can collide with an
// OLD `c1` this device still holds — and a merge that dedupes by id would silently swallow the new
// message. Trading a cosmetic loss for a dropped live line is a bad trade.
//
// So the fold detects the restart instead of ignoring it: if the incoming backlog's highest seq is
// BELOW what we already hold, the counter went backwards, the ids we hold are from a previous life,
// and a replace is the only honest answer. Otherwise the ids are comparable and the union is safe.

/** Live-log ceiling for display. Not the server's backlog size and not related to it — this is how
 *  much scrollback this device keeps in memory. */
export const CHAT_LOG_MAX = 120;

/** The numeric part of a `c<seq>` id, or null when it is not that shape (a future id format must
 *  not be silently ordered as 0 — an unreadable id means we cannot compare lives, so say so). */
function seqOf(id: string): number | null {
  const m = /^c(\d+)$/.exec(id);
  return m ? Number(m[1]) : null;
}

const maxSeq = (msgs: readonly ChatMsg[]): number | null => {
  let hi: number | null = null;
  for (const m of msgs) {
    const n = seqOf(m.id);
    if (n === null) return null; // an id we cannot read → refuse to reason about ordering at all
    if (hi === null || n > hi) hi = n;
  }
  return hi;
};

/** Fold a `chat-history` backlog into the log this device already holds.
 *  Returns the new log, capped, oldest first. */
export function mergeChatHistory(existing: readonly ChatMsg[], incoming: readonly ChatMsg[], cap = CHAT_LOG_MAX): ChatMsg[] {
  if (!existing.length) return incoming.slice(-cap);
  if (!incoming.length) return existing.slice(-cap);

  const hiExisting = maxSeq(existing);
  const hiIncoming = maxSeq(incoming);
  // Unreadable ids, or a counter that went BACKWARDS (a restarted room): our ids are from another
  // life and cannot be compared with these. The server's backlog is the only trustworthy version.
  if (hiExisting === null || hiIncoming === null || hiIncoming < hiExisting) return incoming.slice(-cap);

  // Comparable lives → keep everything, in seq order, without duplicating what we already have.
  const seen = new Set(existing.map((m) => m.id));
  const merged = [...existing, ...incoming.filter((m) => !seen.has(m.id))];
  merged.sort((a, b) => (seqOf(a.id) ?? 0) - (seqOf(b.id) ?? 0));
  return merged.slice(-cap);
}
