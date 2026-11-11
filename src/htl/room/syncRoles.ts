// SYNC / KEY ROLES ACROSS DEVICES — the decisions, pure, beside the wire they ride.
//
// ★ THE ROLE IS STATE, NOT A LABEL (operator, 2026-11-11: session sync audit). A received `sync` /
// `key` intent used to set only the BUTTON (mirrorSyncDisplay), while the engine's own slave id —
// the thing every later press reads — stayed null. So a guest tapping a SYNC button the host had
// engaged read "off", ENGAGED instead of releasing, and its tempo intent then released the host:
// both ends inverted. The receiver now takes the real role (AudioEngine.applySyncRole), which makes
// two questions this file answers:
//
//   1. A tempo (or pitch) arrives for the deck that is the receiver's FOLLOWER. Is it the value the
//      lock itself produced on the sender (an echo — keep the lock), or a hand on the fader (a
//      release — exactly what the same move does locally)? `isRoleEcho` is the one rule.
//   2. What does a sender put on the wire after its roles changed, in what order, so that every
//      receiver lands in the same state? `syncStateIntents` / `keyStateIntents`.

import type { DeckId, Intent } from "./protocol";

/** Tempo values (percent) this close are the same setpoint. The engine's matched tempo is a float
 *  derived from two beatgrids; two devices holding the same grids compute it to well inside this. */
export const SYNC_ECHO_TEMPO_EPS = 0.02;

/** ★ THE DETERMINISTIC RULE for a remote tempo/pitch landing on the receiver's follower deck.
 *
 *  It is an ECHO of the lock (apply it, keep the role) when the sender marked it `follow` — the
 *  sender produced it by following, never by a hand — or when it does not move the deck beyond
 *  `eps` (an unmarked re-broadcast of the same value from an older peer, or emitDeckControls).
 *  Anything else is a user move and releases, exactly as the same move releases locally. A deck that
 *  is not the follower is never an echo: there is nothing to keep. */
export function isRoleEcho(o: { isFollower: boolean; current: number; incoming: number; follow?: boolean; eps: number }): boolean {
  if (!o.isFollower) return false;
  if (o.follow) return true;
  return Math.abs(o.incoming - o.current) <= o.eps;
}

/** Why the roles changed with nobody pressing SYNC/KEY. */
export type AutoRoleCause = {
  /** release = a tempo/pitch write on the follower let it go; handoff = the leader passed to the
   *  live deck; reassert = a load re-aligned (or dropped) the pair. */
  kind: "release" | "handoff" | "reassert";
  /** The write that caused it was a peer's intent being applied here (not this device's gesture). */
  remote: boolean;
};

/** ★ WHO ANNOUNCES A ROLE CHANGE NOBODY PRESSED. The ANCHOR announces every one: it is the board's
 *  authority and runs the hand-off / re-align on the real clock. Any other device announces only a
 *  release ITS OWN gesture caused — a hand on its follower's tempo — because the far side cannot
 *  always tell that hand from the lock's echo (a fader dragged to exactly the value the lock had
 *  already put there is the same number). Everything else a guest's engine does on its own copy of
 *  the board (a hand-off, a re-align computed on a follower's clock) stays local: announcing it
 *  would race the authority with a guess. */
export function shouldAnnounceAutoRole(o: { isAnchor: boolean; cause: AutoRoleCause }): boolean {
  if (o.isAnchor) return true;
  return o.cause.kind === "release" && !o.cause.remote;
}

export interface RoleSource {
  readonly syncSlave: DeckId | null;
  readonly keySlave: DeckId | null;
  deck(id: DeckId): { readonly tempo: number; readonly pitch: number };
}

const otherDeck = (id: DeckId): DeckId => (id === "A" ? "B" : "A");

/** What a device sends after its SYNC roles changed (a press, a Smart Fader throw, the anchor's own
 *  hand-off). ORDER IS THE CONTRACT:
 *    1. the role (`sync`), so the receiver's follower is known before any tempo lands on it;
 *    2. the leader's tempo (a plain setpoint — the receiver's own lock re-matches from it);
 *    3. the follower's tempo, marked `follow`, so it lands as an echo and never releases;
 *    4. the phase-align seek, when the engage moved the follower (the anchor otherwise keeps the
 *       unaligned phase and its tick yanks the presser straight back).
 *  On release only the role crosses: neither deck's tempo moved. */
export function syncStateIntents(src: Pick<RoleSource, "syncSlave" | "deck">, align: { deck: DeckId; pos: number } | null): Intent[] {
  const slave = src.syncSlave;
  const out: Intent[] = [{ kind: "sync", slave }];
  if (slave == null) return out;
  const master = otherDeck(slave);
  out.push({ kind: "control", deck: master, param: "tempo", value: src.deck(master).tempo });
  out.push({ kind: "control", deck: slave, param: "tempo", value: src.deck(slave).tempo, follow: true });
  if (align && align.deck === slave && Number.isFinite(align.pos)) out.push({ kind: "transport", deck: slave, action: "seek", position: align.pos });
  return out;
}

/** What a device sends after its KEY roles changed. The role first; then BOTH decks' pitch, leader
 *  first, the follower marked `follow`. A released follower is no longer a follower, so its pitch (0,
 *  the release) crosses as a plain setpoint and lands as one on a receiver that has already released
 *  it from the role intent. Older peers ignore `follow` and simply take the values, as before. */
export function keyStateIntents(src: Pick<RoleSource, "keySlave" | "deck">): Intent[] {
  const slave = src.keySlave;
  const out: Intent[] = [{ kind: "key", slave }];
  const order: DeckId[] = slave == null ? ["A", "B"] : [otherDeck(slave), slave];
  for (const id of order) {
    const pitch = src.deck(id).pitch;
    out.push(id === slave ? { kind: "control", deck: id, param: "pitch", value: pitch, follow: true } : { kind: "control", deck: id, param: "pitch", value: pitch });
  }
  return out;
}

/** ★ THE ANCHOR'S CONTINUOUS FOLLOW, RATE-LIMITED. While a leader's tempo moves, the anchor's
 *  follower re-matches on every move (matchSlaveTempo) and nothing used to cross: guests' tempo
 *  readout for the follower went stale. Broadcasting every match would be a message per fader
 *  sample; this sends a value only when it moved beyond `eps`, at most once per `minMs`, and always
 *  delivers the LAST value (a trailing flush), so the far side settles exactly where the anchor did. */
export class FollowTempoGate {
  private last: Partial<Record<DeckId, { value: number; at: number }>> = {};
  private pending: Partial<Record<DeckId, number>> = {};
  private timer: Partial<Record<DeckId, unknown>> = {};
  constructor(
    private readonly send: (deck: DeckId, value: number) => void,
    private readonly opts: {
      minMs: number;
      eps: number;
      now: () => number;
      schedule: (fn: () => void, ms: number) => unknown;
      cancel: (h: unknown) => void;
    },
  ) {}

  note(deck: DeckId, value: number): void {
    const last = this.last[deck];
    if (last && Math.abs(value - last.value) <= this.opts.eps) {
      // Back at what was last sent: nothing new to deliver, drop any trailing value.
      if (this.timer[deck] != null) {
        this.opts.cancel(this.timer[deck]);
        this.timer[deck] = undefined;
      }
      this.pending[deck] = undefined;
      return;
    }
    const now = this.opts.now();
    if (!last || now - last.at >= this.opts.minMs) {
      this.fire(deck, value, now);
      return;
    }
    this.pending[deck] = value;
    if (this.timer[deck] == null) {
      this.timer[deck] = this.opts.schedule(() => {
        this.timer[deck] = undefined;
        const v = this.pending[deck];
        this.pending[deck] = undefined;
        if (v != null) this.fire(deck, v, this.opts.now());
      }, this.opts.minMs - (now - last.at));
    }
  }

  /** Forget what was sent (the role went away): the next follow starts fresh. */
  reset(): void {
    for (const id of ["A", "B"] as DeckId[]) if (this.timer[id] != null) this.opts.cancel(this.timer[id]);
    this.last = {};
    this.pending = {};
    this.timer = {};
  }

  private fire(deck: DeckId, value: number, at: number): void {
    this.last[deck] = { value, at };
    this.send(deck, value);
  }
}
