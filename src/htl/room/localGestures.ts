// localGestures — when THIS device last made a transport or loop gesture on each deck, and whether a
// loop change in progress is a REMOTE application (never to be re-broadcast).
//
// ★ Operator, 2026-11-11: session sync audit. The tick follower must not fight this device's own
// gestures: the anchor's next tick may predate a local play / pause / seek (sessionFollow
// inLocalTransportGrace) or a local loop edit (decideLoopHeal). App's `emit` — the one place every
// local intent passes — records them here (noteLocalIntent); the follower reads them. Module state,
// not React state: one engine per page, and it keeps the wiring out of two shared hook signatures.
import type { DeckId, Intent } from "./protocol";
import { isAudibleDeckIntent } from "./sessionFollow";

const transportAt: Record<DeckId, number | null> = { A: null, B: null };
const loopAt: Record<DeckId, number | null> = { A: null, B: null };

/** Record a LOCAL intent (call from the emit path only, never for an inbound one). */
export function noteLocalIntent(intent: Intent, now: number = performance.now()): void {
  if (!("deck" in intent)) return;
  const d = intent.deck;
  if (intent.kind === "loop" || intent.kind === "loopBounds") loopAt[d] = now;
  if (isAudibleDeckIntent(intent.kind, "action" in intent ? String(intent.action) : undefined)) transportAt[d] = now;
}

/** Ms since this device's own last transport gesture (play / pause / seek / hot-cue press) on `deck`. */
export function sinceLocalTransportMs(deck: DeckId, now: number = performance.now()): number | null {
  const t = transportAt[deck];
  return t == null ? null : now - t;
}

/** Ms since this device itself changed `deck`'s loop. */
export function sinceLocalLoopMs(deck: DeckId, now: number = performance.now()): number | null {
  const t = loopAt[deck];
  return t == null ? null : now - t;
}

// A loop region applied FROM THE TICK (the follower's self-heal) is a remote fact, not a gesture: any
// loop-edit broadcast hook (Deck.onLoopEdit → emit loopBounds) must stay silent while it runs.
let remoteLoopDepth = 0;
export function withRemoteLoopApply(fn: () => void): void {
  remoteLoopDepth++;
  try {
    fn();
  } finally {
    remoteLoopDepth--;
  }
}
export function isRemoteLoopApply(): boolean {
  return remoteLoopDepth > 0;
}

/** Tests only. */
export function resetLocalGestures(): void {
  transportAt.A = transportAt.B = null;
  loopAt.A = loopAt.B = null;
  remoteLoopDepth = 0;
}
