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

// ★ TWO AXES, NOT FOUR PANES — and the one-axis version had a measured defect, not a style problem.
//
// This was `{pane:"deck"|"fx", deck}`: four mutually-exclusive panes, with one hysteresis rule
// charged against every move between them. That models a phone's FX view as an ALTERNATIVE to the
// deck. The operator's own sentence says it is not — "mobile can only see one deck, and fx only
// when opened" — fx is a LAYER OVER the deck you are already on.
//
// Treating them as peers produced total stickiness in the most ordinary case there is. Riding an
// effect while working the fader on the same deck alternates `fx:B` and `deck:B`, which under the
// four-pane rule are different panes, so each fader touch refreshed the current pane and blocked
// the FX candidate's dwell forever: measured 0 switches across 6 s of the host riding an effect —
// the listener never saw the FX at all. The hysteresis written to stop DECK thrash was silently
// also blocking the FX layer on the SAME deck, where there is no thrash to prevent because the
// deck is not changing.
//
// The lab scenario that said the rule was fine used a CLEAN block of FX with nothing interleaved.
// That is not what riding an effect looks like; it is what an idealised intent stream looks like,
// and I wrote it.
//
// So: which deck is shown is one question, with hysteresis, because a deck swap is disorienting.
// Whether the FX layer is open is a DIFFERENT question, and on the deck already shown it costs
// nothing to reveal — so it opens at once and closes on a lag, which is how an overlay avoids
// blinking without ever making the viewer wait to see what the host is doing.
export interface Focus {
  deck: DeckId;
  /** Is the FX layer open over that deck. On a phone this is a panel, not a second pane. */
  fx: boolean;
}

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
  /** How long the FX layer stays open after the host's last FX touch on the shown deck.
   *  MUST BOUND: how long a DJ's hand is away from an effect while still working it — the pause
   *  between two reaches, not the length of the whole gesture. Not calibrated, and the asymmetry
   *  is deliberate: opening is free (same deck, nothing displaced), so only the CLOSE is timed. */
  fxHoldMs: number;
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
export const DEFAULT_POLICY: FocusPolicy = { dwellMs: 1200, cooldownMs: 2500, windowMs: 4000, fxHoldMs: 3000 };

/** Which pane an intent is EVIDENCE FOR, or null when it says nothing about where the host is
 *  looking. A crossfade or a tempo-range change is global — attributing it to a deck would invent
 *  attention the host never showed. */
export function focusOf(i: Intent): Focus | null {
  switch (i.kind) {
    case "fxParam":
      return { deck: i.deck, fx: true };
    case "control":
    case "toggle":
    case "stemGain":
    case "stem":
    case "skip":
    case "reqStems":
      return { deck: i.deck, fx: false };
    default:
      return null; // crossfade, tempoRange, sync, key, chat, and everything global
  }
}

export interface FocusState {
  current: Focus | null;
  /** When the shown DECK last changed. The FX layer is not a deck change and does not touch this. */
  switchedAt: number;
  /** Deck-attention evidence inside the window — `fx` is kept so the layer can read it too. */
  recent: { f: Focus; at: number }[];
}

export function initialFocus(current: Focus | null = null): FocusState {
  return { current, switchedAt: -Infinity, recent: [] };
}

/** Fold one intent in and return the new state. The listener shows `state.current`.
 *
 *  ★ THE FIRST FOCUS IS FREE. With no deck yet there is nothing to thrash, and making a listener
 *  stare at a blank pane for the dwell window would be hysteresis protecting nothing. */
export function nextFocus(state: FocusState, i: Intent, at: number, p: FocusPolicy = DEFAULT_POLICY): FocusState {
  const f = focusOf(i);
  if (!f) return state;
  const recent = [...state.recent, { f, at }].filter((r) => at - r.at <= p.windowMs);

  // ── THE FX LAYER, over whichever deck ends up shown. Open the moment the host touches an effect
  // on that deck; close only once their last touch has aged past fxHoldMs. Evidence for a deck we
  // are NOT showing says nothing about the layer over the one we are.
  const layer = (deck: DeckId): boolean => recent.some((r) => r.f.deck === deck && r.f.fx && at - r.at <= p.fxHoldMs);

  if (!state.current) return { current: { deck: f.deck, fx: layer(f.deck) }, switchedAt: at, recent };

  const shown = state.current.deck;
  // ── THE DECK AXIS. Everything below is about which deck is shown, and the FX layer is recomputed
  // from the answer rather than competing with it.
  const hold = (deck: DeckId): FocusState => ({ ...state, current: { deck, fx: layer(deck) }, recent });

  if (f.deck === shown) return hold(shown);
  if (at - state.switchedAt < p.cooldownMs) return hold(shown);
  // The candidate deck must have held attention for the whole dwell: its OLDEST evidence in the
  // window is far enough back, AND nothing for the shown deck has arrived since that point. A host
  // alternating between decks keeps refreshing the shown one, so no candidate ever matures.
  const mine = recent.filter((r) => r.f.deck === f.deck);
  const oldest = mine.length ? mine[0].at : at;
  if (at - oldest < p.dwellMs) return hold(shown);
  if (recent.some((r) => r.f.deck === shown && r.at >= oldest)) return hold(shown);
  return { current: { deck: f.deck, fx: layer(f.deck) }, switchedAt: at, recent };
}
