import type { Intent, DeckId } from "../htl/room/protocol";

// WHAT A FOLLOWING LISTENER LOOKS AT, decided from the host's own intent stream.
//
// The operator ruled that a listener's view FOLLOWS the host, and then named the hard part
// themselves: "the desktop host can see both decks and fx at once, mobile can only see one deck,
// and fx only when opened, so it's not as obvious as it seems at first." A desktop host has no
// single current view to mirror — following means inferring ATTENTION from what they are touching
// and translating it into the one pane a phone has.
//
// ★ AND THE MEASURED GAP LIST (6f00c30) SAYS WHY A NAIVE RULE IS WRONG. The phone carries an
// explicit "showing this deck's controls" indicator, so a host's attention moving from deck A to
// deck B is a pane SWITCH on the listener, not a highlight. A host nudging both decks alternately
// — which is what mixing IS — would thrash the listener's screen several times a second. So the
// rule needs hysteresis BEFORE it needs rendering, and that is the part no thread had named.
//
// This is a PURE function over the intents a listener already receives, so the policy can be
// argued about, tested and shown to the operator without a session, a device, or any UI. It
// decides nothing about how a pane is drawn.

export type Focus = { pane: "deck"; deck: DeckId } | { pane: "fx"; deck: DeckId };

export interface FocusPolicy {
  /** A candidate must hold the host's attention this long before the listener's pane moves.
   *  MUST BOUND: how long a host attends to a new target before the switch is worth a screen
   *  change. Not calibrated — see the note below. */
  dwellMs: number;
  /** After a switch, ignore candidates for this long.
   *  MUST BOUND: how soon a second switch stops reading as following and starts reading as
   *  flicker. Not calibrated. */
  cooldownMs: number;
  /** Intents older than this stop counting toward a candidate's dwell.
   *  MUST BOUND: how long a gesture remains evidence of where the host is looking. Not
   *  calibrated. */
  windowMs: number;
}

// ★ THESE THREE ARE UNCALIBRATED, AND THAT IS DIFFERENT FROM MISCALIBRATED. Practice 7830f717 says
// a constant whose justification is TRUE but about a different quantity than the one it bounds is
// worse than an unjustified one, because the justification stops the next reader from asking. So
// each field above names the quantity it MUST bound, and none of them claims to be derived from it.
// The rationale below is a rationale, not a measurement, and saying which is which is the whole
// point of the practice.
//
// Deliberately slow: a listener is WATCHING, not operating, so showing the wrong deck for another
// second costs far less than a screen that flickers between two.
//
// ★ WHAT WOULD ACTUALLY CALIBRATE THEM, recorded as a hypothesis rather than built on one: a DJ's
// attention moves on MUSICAL time, not wall time — a transition is 16 or 32 bars, so the same
// gesture pattern spans very different milliseconds at 90 bpm and at 174. If that holds, the policy
// belongs in BEATS and the app already knows the tempo. It is not implemented, because it is a
// plausible claim about human behaviour with no trace behind it, and no recorded intent stream
// exists to check it against — that wants the live session that is still blocked. Building it now
// would be inventing a quantity to feel calibrated, which is the same error one layer out.
export const DEFAULT_POLICY: FocusPolicy = { dwellMs: 1200, cooldownMs: 2500, windowMs: 4000 };

/** Which pane an intent is EVIDENCE FOR, or null when it says nothing about where the host is
 *  looking. A crossfade or a tempo-range change is global — attributing it to a deck would invent
 *  attention the host never showed. */
export function focusOf(i: Intent): Focus | null {
  switch (i.kind) {
    case "fxParam":
      return { pane: "fx", deck: i.deck };
    case "control":
    case "toggle":
    case "stemGain":
    case "stem":
    case "skip":
    case "reqStems":
      return { pane: "deck", deck: i.deck };
    default:
      return null; // crossfade, tempoRange, sync, key, chat, and everything global
  }
}

const same = (a: Focus, b: Focus) => a.pane === b.pane && a.deck === b.deck;
const key = (f: Focus) => `${f.pane}:${f.deck}`;

export interface FocusState {
  current: Focus | null;
  switchedAt: number;
  recent: { f: Focus; at: number }[];
}

export function initialFocus(current: Focus | null = null): FocusState {
  return { current, switchedAt: -Infinity, recent: [] };
}

/** Fold one intent in and return the new state. The listener's pane is `state.current`.
 *
 *  ★ THE FIRST FOCUS IS FREE. With no pane yet there is nothing to thrash, and making a listener
 *  stare at a blank pane for the dwell window would be hysteresis protecting nothing. */
export function nextFocus(state: FocusState, i: Intent, at: number, p: FocusPolicy = DEFAULT_POLICY): FocusState {
  const f = focusOf(i);
  if (!f) return state;
  const recent = [...state.recent, { f, at }].filter((r) => at - r.at <= p.windowMs);
  if (!state.current) return { current: f, switchedAt: at, recent };
  if (same(f, state.current)) return { ...state, recent };
  if (at - state.switchedAt < p.cooldownMs) return { ...state, recent };
  // The candidate must have held attention for the whole dwell: its OLDEST evidence in the window
  // is far enough back, AND nothing for the current pane has arrived since that point. A host
  // alternating between decks keeps refreshing the current pane, so no candidate ever matures.
  const mine = recent.filter((r) => key(r.f) === key(f));
  const oldest = mine.length ? mine[0].at : at;
  if (at - oldest < p.dwellMs) return { ...state, recent };
  const currentSince = recent.filter((r) => key(r.f) === key(state.current!) && r.at >= oldest);
  if (currentSince.length) return { ...state, recent };
  return { current: f, switchedAt: at, recent };
}
