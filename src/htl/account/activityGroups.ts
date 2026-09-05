import type { NotifEvent } from "./index";

// How the Activity feed decides what you see first, and what it rolls up.
//
// ★ THE FEED WAS FLAT REVERSE-CHRON, which is the wrong shape the moment there is volume: an
// INVITE you have to answer sat underneath thirty "X followed you" from five minutes ago, and
// the one cursor stamped on tab-open marked the lot seen — including the item you opened the tab
// to come back to. Two failures from one arrangement: nothing distinguished an event that NEEDS
// you from an event that merely informs you, and time was the only axis.
//
// So: ACTIONABLE first (never rolled up, never auto-cleared), then the rest by day, with the
// high-frequency informational kinds rolled into one line. This is the same split the Session
// screen's "Waiting on you" makes — a person blocked on you outranks ambient activity — applied
// to the surface that has the most ambient activity of all.

/** Kinds that ask something of the viewer. Everything else is news. Open-ended `kind` from the
 *  server means the DEFAULT must be "informational": a kind we have never heard of is not
 *  allowed to silently claim the top of the list. */
const ACTIONABLE = new Set(["invite", "follow_request", "stage_request", "knock"]);

export function isActionable(e: NotifEvent): boolean {
  return ACTIONABLE.has(e.kind);
}

/** Kinds worth collapsing when several arrive — a follow is identical news each time, so thirty
 *  of them are one fact with a number, not thirty rows. A mention is NOT rolled up: each one is
 *  a different thing somebody said. */
const ROLLUP = new Set(["follow"]);
/** Below this, showing the rows individually is more useful than counting them. */
export const ROLLUP_MIN = 3;

export interface DayGroup {
  /** Local-midnight timestamp — the group's identity and sort key. */
  day: number;
  label: string;
  events: NotifEvent[];
  /** Collapsed kinds → how many, e.g. { follow: 12 }. Rendered as one line each. */
  rollups: { kind: string; count: number; events: NotifEvent[] }[];
  unread: number;
}

/** Local midnight for a timestamp. Local, not UTC: "yesterday" means the user's yesterday. */
export function dayKey(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function dayLabel(day: number, now: number): string {
  const today = dayKey(now);
  if (day === today) return "Today";
  if (day === today - 86_400_000) return "Yesterday";
  const d = new Date(day);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) });
}

export interface Activity {
  /** Events that ask something of you — newest first, never rolled up, never grouped by day.
   *  A request does not become less pressing for being from Tuesday. */
  needsYou: NotifEvent[];
  /** Everything else, newest day first. */
  days: DayGroup[];
}

export function groupActivity(events: NotifEvent[], seenAt: number, now = Date.now()): Activity {
  const needsYou: NotifEvent[] = [];
  const rest: NotifEvent[] = [];
  for (const e of events) (isActionable(e) ? needsYou : rest).push(e);
  needsYou.sort((a, b) => b.createdAt - a.createdAt);

  const byDay = new Map<number, NotifEvent[]>();
  for (const e of rest) {
    const k = dayKey(e.createdAt);
    const list = byDay.get(k);
    if (list) list.push(e);
    else byDay.set(k, [e]);
  }

  const days: DayGroup[] = [...byDay.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([day, list]) => {
      list.sort((a, b) => b.createdAt - a.createdAt);
      const counts = new Map<string, NotifEvent[]>();
      for (const e of list) {
        if (!ROLLUP.has(e.kind)) continue;
        const c = counts.get(e.kind);
        if (c) c.push(e);
        else counts.set(e.kind, [e]);
      }
      const rollups = [...counts.entries()]
        .filter(([, es]) => es.length >= ROLLUP_MIN)
        .map(([kind, es]) => ({ kind, count: es.length, events: es }));
      const rolled = new Set(rollups.flatMap((r) => r.events.map((e) => e.id)));
      return {
        day,
        label: dayLabel(day, now),
        events: list.filter((e) => !rolled.has(e.id)),
        rollups,
        unread: list.filter((e) => e.createdAt > seenAt).length,
      };
    });

  return { needsYou, days };
}
