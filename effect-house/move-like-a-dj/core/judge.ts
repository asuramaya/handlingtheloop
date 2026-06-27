import type { Note } from "./chart";
import type { GameClock } from "./clock";
import type { GestureEvent } from "./gesture";

// Timing judgment. Windows are deliberately generous — body tracking is jittery,
// the effect runs at a modest frame rate, and a game you can't rage-quit is the
// one that travels. Tune on device, err wider.
export type Verdict = "PERFECT" | "GREAT" | "GOOD" | "MISS";

export const WINDOWS = { perfect: 0.12, great: 0.2, good: 0.28 } as const;

export interface ScheduledNote extends Note {
  targetTime: number;
  judged: boolean;
  verdict?: Verdict;
}

export function scheduleChart(notes: Note[], clock: GameClock): ScheduledNote[] {
  return notes
    .map((n) => ({ ...n, targetTime: clock.targetTimeOf(n.beatIndex), judged: false }))
    .sort((a, b) => a.targetTime - b.targetTime);
}

function verdictFor(err: number): Verdict | null {
  if (err <= WINDOWS.perfect) return "PERFECT";
  if (err <= WINDOWS.great) return "GREAT";
  if (err <= WINDOWS.good) return "GOOD";
  return null;
}

export class Judge {
  constructor(private readonly notes: ScheduledNote[]) {}

  /**
   * Resolve a gesture event against the nearest unjudged note of matching type
   * within the widest window. Marks the note judged. Returns the outcome or null
   * if nothing matchable is in range (a stray move — ignored, not penalised).
   */
  resolve(ev: GestureEvent): { note: ScheduledNote; verdict: Verdict } | null {
    let best: ScheduledNote | null = null;
    let bestErr = Infinity;
    for (const n of this.notes) {
      if (n.judged || n.type !== ev.type) continue;
      const err = Math.abs(ev.tEvent - n.targetTime);
      if (err < bestErr) {
        bestErr = err;
        best = n;
      }
    }
    if (!best) return null;
    const verdict = verdictFor(bestErr);
    if (!verdict) return null; // nearest note still outside GOOD -> not this note's hit
    best.judged = true;
    best.verdict = verdict;
    return { note: best, verdict };
  }

  /** Flip any note whose window has fully closed to MISS. Call each frame. */
  reap(now: number): ScheduledNote[] {
    const missed: ScheduledNote[] = [];
    for (const n of this.notes) {
      if (!n.judged && now > n.targetTime + WINDOWS.good) {
        n.judged = true;
        n.verdict = "MISS";
        missed.push(n);
      }
    }
    return missed;
  }

  get unresolved(): number {
    return this.notes.filter((n) => !n.judged).length;
  }
}
