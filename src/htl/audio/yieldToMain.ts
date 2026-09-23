// GIVING THE THREAD BACK, WITH THE BEST PRIMITIVE THIS ENGINE ACTUALLY HAS.
//
// ★ WHY THIS EXISTS AT ALL IS A FILING MISTAKE, AND IT IS WORTH NAMING. Thread 9d03d3e1 parked the
// yield choice on a device question — "does iOS expose scheduler.yield and/or scheduler.postTask" —
// and opus.ts said so in a comment that ended: "the fallback from an absent API is this timer."
// That sentence IS the answer. Knowing which branch iOS takes was never required to WRITE the
// branch. The blocker was on the conclusion (is iOS faster now?), never on the premise (can we pick
// the best available yield?), and a blocker on the conclusion is not a blocker on the premise —
// Metron's rule, from measuring 971d5eb2's OOM premise headlessly after filing the whole item as
// needing a phone (0776999). Three items in three passes have now come out from behind a label.
//
// ★ THE ORDER IS QUEUE POSITION ON RESUMPTION, which is the one axis that explained the whole
// stemlab grid rather than one column of it (b18a3dac). setTimeout and rAF resume BEHIND whatever
// was queued while we slept; scheduler.yield and postTask(user-blocking) resume AHEAD of it. Those
// two measured ~3.5x less blocking than setTimeout(0) for the same work. postTask(background) sits
// with the timers, so it is not in this chain — same API as the fast one, wrong priority.
//
// ★ WHAT THIS CHANGES ON A PLATFORM WE HAVE NOT MEASURED: nothing. An engine exposing neither API
// lands on setTimeout(0), which is exactly today's behaviour, so the change cannot regress iOS even
// if iOS is the platform with nothing. What it cannot do is TELL us — `yieldPrimitive()` is the
// witness for the console probe 9d03d3e1 still wants, and that probe is now a confirmation rather
// than a gate.
//
// ★ AND THE HONEST COST, because resuming AHEAD is not free: work that arrived during the yield now
// waits for the decode's continuation instead of overtaking it. That is the whole reason it blocks
// less — the total window is shorter — but it does mean a long decode holds off other queued app
// work more firmly than the timer did. Rendering is unaffected either way: the event loop puts paint
// above user-blocking tasks, which is why yield can be both ahead of tasks and behind frames.

type Schedulerish = {
  scheduler?: {
    yield?: () => Promise<void>;
    postTask?: (f: () => void, o: { priority: string }) => Promise<unknown>;
  };
};

export type YieldPrimitive = "scheduler.yield" | "scheduler.postTask" | "setTimeout";

const TIMER = (): Promise<void> => new Promise<void>((r) => setTimeout(r, 0));

let chosen: { name: YieldPrimitive; fn: () => Promise<void> } | null = null;

function detect(): { name: YieldPrimitive; fn: () => Promise<void> } {
  const g = globalThis as unknown as Schedulerish;
  // Read the member, don't just test the object: an engine can ship `scheduler` with postTask and
  // no yield, which is exactly the split that makes probing only one of them able to retire a fix
  // that exists.
  if (typeof g.scheduler?.yield === "function") return { name: "scheduler.yield", fn: () => g.scheduler!.yield!() };
  if (typeof g.scheduler?.postTask === "function") {
    return { name: "scheduler.postTask", fn: () => g.scheduler!.postTask!(() => {}, { priority: "user-blocking" }).then(() => {}) };
  }
  return { name: "setTimeout", fn: TIMER };
}

/** Hand the thread back between chunks of heavy work. Never rejects: a scheduler that throws or
 *  rejects is DEMOTED to the timer for the rest of the session rather than killing the loop that
 *  called it — a decode giving the thread back must not be able to fail at giving the thread back. */
export async function yieldToMain(): Promise<void> {
  const c = (chosen ??= detect());
  if (c.name === "setTimeout") return TIMER();
  try {
    await c.fn();
  } catch {
    chosen = { name: "setTimeout", fn: TIMER };
    await TIMER();
  }
}

/** Which primitive this engine resolved to — the witness. A device that falls back silently and a
 *  device that has the fast path look identical from the outside, and telling them apart is the
 *  entire remaining content of the yield half of thread 9d03d3e1. */
export function yieldPrimitive(): YieldPrimitive {
  return (chosen ??= detect()).name;
}

/** Tests only — detection is cached because an engine does not grow an API mid-session. */
export function resetYieldPrimitive(): void {
  chosen = null;
}
