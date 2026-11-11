// scrubGuard — the per-deck "a scrub is in flight, don't follow the tick" flag, with a watchdog.
//
// ★ Operator, 2026-11-11: session sync audit. The flag was a bare boolean set on jog START and cleared
// by a 250 ms timer after jog END. Two ways it stuck true forever, and a stuck flag means the follower
// never follows that deck again: (1) the END was lost — the scratching guest's controller or socket
// dropped mid-scratch; (2) start, end, start within 250 ms — the FIRST end's timer cleared the SECOND
// scratch's flag mid-gesture (and the second scratch's own end then cleared nothing it owned). Now each
// end's tail carries a generation token (a newer start or move cancels it), and a scrub with no start
// or move for SCRUB_WATCHDOG_MS expires — unless this device's own hand is still on the platter.

export const SCRUB_TAIL_MS = 250;
export const SCRUB_WATCHDOG_MS = 1500;

export interface ScrubFlag {
  active: boolean;
  lastAt: number; // ms of the last start / move (the watchdog's clock)
  gen: number; //   bumped by every start / move / end; a tail timer only clears its own generation
  local: boolean; // this device's own gesture (its held platter is visible to it), not a peer's
}

export function scrubIdle(): ScrubFlag {
  return { active: false, lastAt: 0, gen: 0, local: false };
}

export function scrubBegin(f: ScrubFlag, now: number, local: boolean): void {
  f.active = true;
  f.lastAt = now;
  f.local = local;
  f.gen++;
}

/** A move is proof of life — and if its start was lost, it starts the scrub. */
export function scrubMove(f: ScrubFlag, now: number, local: boolean): void {
  if (!f.active) f.local = local;
  f.active = true;
  f.lastAt = now;
  f.gen++;
}

/** The scrub ended: returns the token the SCRUB_TAIL_MS timer must hand to scrubTailDone. */
export function scrubEnd(f: ScrubFlag): number {
  return ++f.gen;
}

/** The tail elapsed: clear the flag only if nothing started since this end. */
export function scrubTailDone(f: ScrubFlag, token: number): void {
  if (f.gen === token) f.active = false;
}

/** Is the deck scrubbing now? `held` = this device's own hand still grips the platter (Deck.grabbing),
 *  which keeps a LOCAL scrub alive while it holds still. "expired" = the watchdog just fired on a scrub
 *  whose end never came (the caller releases the platter it left gripped). */
export function checkScrub(f: ScrubFlag, now: number, held: boolean): "active" | "idle" | "expired" {
  if (!f.active) return "idle";
  if (f.local && held) {
    f.lastAt = now;
    return "active";
  }
  if (now - f.lastAt > SCRUB_WATCHDOG_MS) {
    f.active = false;
    f.gen++;
    return "expired";
  }
  return "active";
}
