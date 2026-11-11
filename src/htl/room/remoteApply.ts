// "AM I APPLYING SOMEONE ELSE'S GESTURE RIGHT NOW?" — one module-level answer.
//
// ★ THE ECHO (operator, 2026-11-11: session sync audit). A deck reports its own loop edits through
// Deck.onLoopEdit so the App can broadcast them. The same deck methods also run when a PEER's intent
// is applied, so a receiver re-running a beat loop fired onLoopEdit and broadcast ITS recomputed
// region straight back, and the sender adopted the receiver's region over its own. Any path that
// applies state which came from elsewhere (applyIntent, a tick's loop heal, a snapshot reconcile)
// runs inside withRemote, and the broadcasters check isApplyingRemote and stay quiet.
//
// Synchronous by design: the deck mutations are synchronous, so a depth counter is exact. Nested
// calls (applyIntent inside a heal) keep it raised until the outermost one returns.

let depth = 0;

/** Run `fn` as the application of remote state: local broadcasters stay silent while it runs. */
export function withRemote<T>(fn: () => T): T {
  depth++;
  try {
    return fn();
  } finally {
    depth--;
  }
}

/** True while a withRemote block is running. */
export function isApplyingRemote(): boolean {
  return depth > 0;
}
