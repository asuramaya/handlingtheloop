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

/** The numeric part of a `c<seq>` id, or null when it is not that shape. */
function seqOf(id: string): number | null {
  const m = /^c(\d+)$/.exec(id);
  return m ? Number(m[1]) : null;
}

/** The highest sequence among the ids we CAN read, or null when none are readable.
 *
 *  ★ ONE UNREADABLE ID USED TO COLLAPSE THE WHOLE FOLD — Metron's catch, and it is the bug this
 *  module exists to fix, reachable again through the front door. `ChatMsg.id` is typed `string`;
 *  today exactly one place mints one (roomCrowd.ts:167, `c${++this.seq}`), so every id is readable.
 *  But the moment anything else posts a line — a system notice, a moderation message, a hype bridge
 *  — its id is not `c<n>`, this returned null, and EVERY merge became a replace, silently, and only
 *  in rooms where such a line exists. The worst kind of intermittent.
 *
 *  His proposal was to brand the id so the type refuses a hand-built one. That constrains producers
 *  in THIS repo and says nothing about what actually arrives over the wire, where the client parses
 *  whatever it is sent. So the fold stops depending on the convention instead: unreadable ids are
 *  carried, they simply do not vote on which life the backlog belongs to. */
function maxSeq(msgs: readonly ChatMsg[]): number | null {
  let hi: number | null = null;
  for (const m of msgs) {
    const n = seqOf(m.id);
    if (n !== null && (hi === null || n > hi)) hi = n;
  }
  return hi;
}

/** Fold a `chat-history` backlog into the log this device already holds.
 *  Returns the new log, capped, oldest first. */
export function mergeChatHistory(existing: readonly ChatMsg[], incoming: readonly ChatMsg[], cap = CHAT_LOG_MAX): ChatMsg[] {
  if (!existing.length) return incoming.slice(-cap);
  // An empty backlog is never SENT (sendChatHistory only fires when history.length), so this is the
  // defensive end rather than a real state. Noted because it is the one case where we knowingly keep
  // a possibly-dead life's lines: the client cannot tell "no backlog" from "empty room".
  if (!incoming.length) return existing.slice(-cap);

  const hiExisting = maxSeq(existing);
  const hiIncoming = maxSeq(incoming);
  // A counter that went BACKWARDS is a restarted room: our ids are from a previous life and the
  // server's backlog is the only trustworthy version. Sound because the counter and the log SHARE A
  // LIFETIME — roomCrowd.ts holds `log` and `seq` as two fields of one in-memory object, so a
  // restart empties one and resets the other as a single act (Metron checked the path where they
  // could diverge; it does not exist). If NEITHER side has a readable id there is no comparison to
  // make at all, and the backlog wins for the same reason.
  if (hiExisting === null || hiIncoming === null || hiIncoming < hiExisting) return incoming.slice(-cap);

  // Comparable lives → keep everything, without duplicating what we already have.
  const seen = new Set(existing.map((m) => m.id));
  const all = [...existing, ...incoming.filter((m) => !seen.has(m.id))];

  // ★ SEQUENCED AND UNSEQUENCED ARE SORTED SEPARATELY, because a comparator that treats an
  // unreadable id as 0 does not "fail to order" it — it claims a position, at the TOP, which for a
  // chat log means burying a system notice above a conversation it came after. Partitioned rather
  // than compared: the readable ids order by sequence, the rest keep the relative order they
  // arrived in and sit at the end, which in a chat log is the most-recent position and the only
  // honest default for a line we cannot place.
  const sequenced = all.filter((x) => seqOf(x.id) !== null).sort((a, b) => seqOf(a.id)! - seqOf(b.id)!);
  const unsequenced = all.filter((x) => seqOf(x.id) === null);
  return [...sequenced, ...unsequenced].slice(-cap);
}
