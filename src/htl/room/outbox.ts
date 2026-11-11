// THE INTENT OUTBOX — what a device holds while it cannot be heard (operator, 2026-11-11: session
// sync audit).
//
// RoomClient.send used to drop anything while the socket was not OPEN, and after any reconnect the
// fresh socket starts un-joined, so the room ALSO dropped every intent sent before it processed the
// join. A loop set, a load, a crossfade made in those seconds was applied locally and never shared:
// the "commands get lost" report. Intents are now held here while disconnected or not yet re-joined
// and flushed, in order, once the room confirms the join.
//
// Bounded twice, because a device can be offline for a long time and a replayed gesture from a minute
// ago is worse than a lost one: at most MAX entries (oldest shed first) and nothing older than
// MAX_AGE_MS survives a drain. CONTINUOUS kinds (the same set the room's listener digest coalesces)
// keep only their last value per target, keyed by digestKey — and the replacement moves to the END,
// so a sweep's final value still lands after any discrete intent that came between (an fxParam after
// the fxRack reorder it followed must address the NEW slot). Never ticks or state: those are
// superseded by the next one and are not intents.
import type { Intent } from "./protocol";
import { digestKey } from "./digestKey";

/** Kinds whose last value per target is all that matters (mirrors room.ts COALESCE_KINDS). */
export const OUTBOX_COALESCE_KINDS: ReadonlySet<string> = new Set(["control", "crossfade", "stemGain", "fxParam"]);

export interface OutboxEntry {
  intent: Intent;
  at: number;
}

export class IntentOutbox {
  private q: OutboxEntry[] = [];
  /** How many intents were shed for the cap or for age since the last drain (for the flight recorder). */
  dropped = 0;

  constructor(
    readonly max = 200,
    readonly maxAgeMs = 10_000,
  ) {}

  get size(): number {
    return this.q.length;
  }

  push(intent: Intent, now: number): void {
    if (OUTBOX_COALESCE_KINDS.has(intent.kind)) {
      const k = digestKey(intent);
      const i = this.q.findIndex((e) => OUTBOX_COALESCE_KINDS.has(e.intent.kind) && digestKey(e.intent) === k);
      if (i >= 0) this.q.splice(i, 1);
    }
    this.q.push({ intent, at: now });
    if (this.q.length > this.max) {
      this.dropped += this.q.length - this.max;
      this.q.splice(0, this.q.length - this.max);
    }
  }

  /** Everything still fresh, oldest first; empties the outbox. */
  drain(now: number): Intent[] {
    const fresh = this.q.filter((e) => now - e.at <= this.maxAgeMs);
    this.dropped += this.q.length - fresh.length;
    this.q = [];
    return fresh.map((e) => e.intent);
  }

  clear(): void {
    this.q = [];
  }
}
