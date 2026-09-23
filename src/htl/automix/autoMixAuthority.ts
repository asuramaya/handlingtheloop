// WHO MAY ARM AUTO-MIX — one predicate, because I wrote it twice with opposite polarity first.
//
// ★ OPERATOR RULING, 2026-09-23 (thread cb9000d2, decision 34075fae): auto-mix is HOST ONLY.
//
// Auto-mix is a whole-board activity by construction — it drives both decks AND the crossfader —
// so a seat that cannot move the board could never complete a transition. The honest moment to say
// so is when the person asks, not halfway through one.
//
// `controlling` was the gate before this and it was the wrong question, in a way that had already
// failed once. A stepped-up listener holds controlling=true with ONE deck, so the client sent an
// `automix` intent — and the server dropped it, because that intent carries no `deck` and
// canDriveIntent then demands BOTH. The control looked live and nothing happened: the silent
// divergence 2e77ffb fixed in the crossfade mutator, one level up at the arming control.
//
// The operator went further than "refuse a stage DJ": any seat not on the session-owner's account
// is refused, including a fully-granted guest holding AB. That is a product call about whose rig
// this is and is not derivable from the audio graph, which is why it is stated here rather than
// inferred from `decks`.
//
// A host's OWN second device still arms it — that is the remote-surface case the attachment model
// exists for, and `host` is set by the Worker per account, un-forgeably, so it stays true there.
export interface AutoMixSeat {
  /** In a room at all. Solo rigs are always allowed — the seat rules bind only inside a room. */
  enabled: boolean;
  /** This device is on the session-owner's account (Worker-set, un-forgeable). */
  host: boolean;
}

export const canArmAutoMix = (seat: AutoMixSeat): boolean => !seat.enabled || seat.host;
