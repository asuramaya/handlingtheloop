import { dumpRing, event } from "./trace";

// ★ HOW DID THE LAST SESSION END? (operator, 2026-11-14: "find a way to diff between a refresh and
// a legitimate crash on mobile or desktop".) A tab that dies leaves no exception, no rejection and
// no log; the next boot looks like any other. The decode guard tried to notice one kind of death
// and could not tell it from a refresh (measured: a plain page reload printed "the tab went down
// while decoding"). So the app keeps a tiny record of its own life and reads it on the next boot:
//
//   • every boot writes { id, start, state } and a heartbeat (every BEAT_MS while visible),
//   • `pagehide` stamps a clean exit: a refresh, a close, a navigation all fire it; a crash, an OOM
//     kill or an Aw-Snap never does,
//   • the page's visibility is recorded as it changes, because a phone kills BACKGROUND tabs as a
//     matter of course and that is not our crash,
//   • and the last few flight-recorder events ride along with each beat, so the boot after a crash
//     can show what the dead session was doing in its last seconds (the ring itself dies with it).
//
// Never sent anywhere by itself: the verdicts show in Settings ▸ Debug and in a bug report the user
// chooses to send (operator: "keep debug send an explicit thing").
export type ExitKind =
  | "first" // no record: first boot on this device (or storage was cleared)
  | "refresh" // clean exit, and this boot is a reload
  | "closed" // clean exit: closed, navigated away, or opened again later
  | "background" // no clean exit, last seen HIDDEN: the OS or browser killed a background tab
  | "discarded" // the browser says it discarded the tab (Chrome's document.wasDiscarded)
  | "crash"; // no clean exit while VISIBLE: OOM, renderer crash, Aw-Snap, iOS "a problem occurred"

export interface LifeRecord {
  id: string;
  start: number; // epoch ms the session booted
  beat: number; // epoch ms of the last heartbeat / state change
  state: "visible" | "hidden" | "frozen";
  exit: "pagehide" | null;
  tail?: Array<Record<string, unknown>>; // the last events before the beat
}

export interface ExitVerdict {
  kind: ExitKind;
  at: number; // when the previous session was last seen alive (epoch ms)
  uptimeS: number; // how long it had been running
  lastState: LifeRecord["state"] | null;
  tail: Array<Record<string, unknown>>; // its last events (kept only for the unclean kinds)
}

const KEY = "htl:life";
const HIST_KEY = "htl:lifeHist";
const HIST_MAX = 8;
const TAIL_N = 40;
export const BEAT_MS = 5000;

/** The pure decision. `nav` is this boot's PerformanceNavigationTiming.type. */
export function classifyExit(prev: LifeRecord | null, nav: string, wasDiscarded: boolean): ExitKind {
  if (!prev) return "first";
  if (prev.exit === "pagehide") return nav === "reload" ? "refresh" : "closed";
  if (wasDiscarded) return "discarded";
  if (prev.state !== "visible") return "background";
  return "crash";
}

let verdict: ExitVerdict | null = null;
let current: LifeRecord | null = null;

const read = <T,>(k: string): T | null => {
  try {
    const raw = localStorage.getItem(k);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
};
const write = (k: string, v: unknown) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* full / private mode: the record is best-effort */
  }
};
const save = (withTail: boolean) => {
  if (!current) return;
  current.beat = Date.now();
  if (withTail) current.tail = dumpRing().slice(-TAIL_N);
  write(KEY, current);
};

/** Call once, as early as possible. Returns how the previous session ended. */
export function initLifecycle(): ExitVerdict {
  if (verdict) return verdict;
  const prev = read<LifeRecord>(KEY);
  let nav = "navigate";
  let discarded = false;
  try {
    nav = (performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined)?.type ?? "navigate";
    discarded = !!(document as Document & { wasDiscarded?: boolean }).wasDiscarded;
  } catch {
    /* old browser: classify without them */
  }
  const kind = classifyExit(prev, nav, discarded);
  const unclean = kind === "crash" || kind === "background" || kind === "discarded";
  verdict = {
    kind,
    at: prev?.beat ?? 0,
    uptimeS: prev ? Math.round((prev.beat - prev.start) / 1000) : 0,
    lastState: prev?.state ?? null,
    tail: unclean ? (prev?.tail ?? []) : [],
  };
  if (kind !== "first") {
    const hist = read<ExitVerdict[]>(HIST_KEY) ?? [];
    // only a crash keeps its tail in the history; the rest are one line each
    hist.unshift({ ...verdict, tail: kind === "crash" ? verdict.tail : [] });
    write(HIST_KEY, hist.slice(0, HIST_MAX));
  }
  event("boot.prevExit", { kind, lastState: verdict.lastState ?? "-", uptimeS: verdict.uptimeS, nav });
  if (kind === "crash")
    console.warn(
      `[htl] the previous session ended without unloading while it was on screen (crash / out of memory), ` +
        `${verdict.uptimeS}s in. Its last ${verdict.tail.length} events are in Settings ▸ Debug ▸ Lifecycle.`,
    );

  if (typeof window !== "undefined") {
    current = {
      id: Math.random().toString(36).slice(2, 10),
      start: Date.now(),
      beat: Date.now(),
      state: document.visibilityState === "visible" ? "visible" : "hidden",
      exit: null,
    };
    save(true);
    const beat = window.setInterval(() => {
      if (current?.state === "visible") save(true);
    }, BEAT_MS);
    document.addEventListener("visibilitychange", () => {
      if (!current) return;
      current.state = document.visibilityState === "visible" ? "visible" : "hidden";
      save(true);
    });
    document.addEventListener("freeze", () => {
      if (!current) return;
      current.state = "frozen";
      save(true);
    });
    document.addEventListener("resume", () => {
      if (!current) return;
      current.state = document.visibilityState === "visible" ? "visible" : "hidden";
      save(false);
    });
    window.addEventListener("pagehide", () => {
      if (!current) return;
      current.exit = "pagehide";
      save(false);
    });
    // Back from the back/forward cache: the page lives again, so the clean exit is withdrawn.
    window.addEventListener("pageshow", (e) => {
      if (!current || !(e as PageTransitionEvent).persisted) return;
      current.exit = null;
      current.state = "visible";
      save(true);
    });
    void beat;
  }
  return verdict;
}

/** How the previous session ended (null before initLifecycle). */
export function lastExit(): ExitVerdict | null {
  return verdict;
}

/** The recent exits, newest first (a crash keeps its last events). */
export function exitHistory(): ExitVerdict[] {
  return read<ExitVerdict[]>(HIST_KEY) ?? [];
}

export const EXIT_LABEL: Record<ExitKind, string> = {
  first: "first run",
  refresh: "refreshed",
  closed: "closed / navigated away",
  background: "ended in the background (closed from the app switcher, or evicted)",
  discarded: "discarded by the browser to save memory",
  crash: "CRASHED while on screen (out of memory or a renderer crash)",
};
