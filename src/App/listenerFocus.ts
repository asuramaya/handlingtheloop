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
  /** A candidate must hold the host's attention this long before the listener's pane moves. */
  dwellMs: number;
  /** After a switch, ignore candidates for this long — a screen that just changed is expensive. */
  cooldownMs: number;
  /** Intents older than this stop counting toward a candidate's dwell. */
  windowMs: number;
}

// Deliberately slow. A listener is WATCHING, not operating: the cost of showing the wrong deck for
// another second is far below the cost of a screen that flickers between two. These are the numbers
// the operator should push back on, which is why they are named and not inlined.
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
