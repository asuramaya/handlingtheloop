import type { LiveRoom } from "./index";

// How Discover decides what you see first, and what it TELLS you about why.
//
// ★ THE PROBLEM THIS SOLVES IS LEGIBILITY, NOT PERFORMANCE. Discover used to stack four
// unbounded lists — Friends online, From people you follow, Also live now, Sets — and at any
// real scale the arrangement inverts on itself: the top section is the highest-intent one, so
// with forty friends online it fills the viewport and the live directory beneath it becomes
// unreachable. Section ORDER only expresses priority while every section is short.
//
// One ranked list fixes that, but only if each row can say why it is there — otherwise ranking
// is invisible and the list reads as arbitrary. So every row carries a REASON, and the reason is
// the same thing the sort used.
export type Reason = "friend" | "following" | "popular" | "fresh";

export interface RankedRoom {
  room: LiveRoom;
  reason: Reason;
}

/** Rooms that started within this window are candidates for "fresh" — the newcomer slot that
 *  stops the directory being a pure popularity ratchet. */
export const FRESH_MS = 15 * 60_000;

/** ...but ONLY if they are actually small. ★ CAUGHT BY THE SCALE FIXTURE: with recency as the
 *  sole test, the biggest room in a 141-room directory — 900 listeners, on air 30 seconds —
 *  was labelled "Just started" and promoted ABOVE every established room. The anti-ratchet slot
 *  had been captured by exactly the kind of room it exists to counterbalance, and it read as
 *  nonsense besides: nobody calls the busiest room in the building a newcomer. A newcomer is
 *  new AND small; a big room that just came on is simply popular. */
export const FRESH_MAX_LISTENERS = 25;

export function reasonFor(r: LiveRoom, now: number): Reason {
  if (r.rel === 2) return "friend";
  if (r.rel === 1) return "following";
  const justOn = !!r.startedAt && now - r.startedAt < FRESH_MS;
  if (justOn && r.listeners <= FRESH_MAX_LISTENERS) return "fresh";
  return "popular";
}

const WEIGHT: Record<Reason, number> = { friend: 3, following: 2, fresh: 1, popular: 0 };

export const REASON_LABEL: Record<Reason, string> = {
  friend: "Friend",
  following: "You follow",
  fresh: "Just started",
  popular: "Popular",
};

/** Rank rooms relationship-first, then by listeners. The server already orders this way, but the
 *  client re-sorts because it ALSO folds in freshness, which the server cannot know the cutoff
 *  for, and because a filtered subset must stay ordered. Stable on ties via handle so the list
 *  does not shuffle under a 30 s poll — a row that moves while you are reaching for it is worse
 *  than a row in the wrong place. */
export function rankRooms(rooms: LiveRoom[], now: number): RankedRoom[] {
  return rooms
    .map((room) => ({ room, reason: reasonFor(room, now) }))
    .sort(
      (a, b) =>
        WEIGHT[b.reason] - WEIGHT[a.reason] ||
        b.room.listeners - a.room.listeners ||
        a.room.handle.localeCompare(b.room.handle),
    );
}

/** Free-text filter over what a row actually SHOWS — handle, name, title, genre, now-playing.
 *  At a hundred rooms browsing stops working and searching starts; this is the same box that
 *  finds people, widened to find rooms. */
export function filterRooms(ranked: RankedRoom[], q: string): RankedRoom[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return ranked;
  return ranked.filter(({ room }) =>
    [room.handle, room.displayName, room.title, room.genre, room.npTitle, room.npArtist]
      .filter(Boolean)
      .some((v) => String(v).toLowerCase().includes(needle)),
  );
}
