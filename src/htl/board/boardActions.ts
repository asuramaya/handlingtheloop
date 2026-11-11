import type { Deck } from "@htl/audio";

type PadMode = "cue" | "cue2" | "loop" | "sampler" | "fx";

// Board-agnostic gesture bus. The room protocol carries ONE `board` intent {deck, id, phase,
// arg} and never learns about specific buttons — new pads / modes / effects sync + replay by
// REGISTERING an apply fn here, not by editing the protocol or App.applyIntent. This keeps the
// transport stable across board iterations (the user adds FX pads constantly): the recipe, the
// session sync, and replay all flow through the same dumb pipe + this registry.
//
// `id` is a board-namespaced action key ("padMode", "fxPad", …). `phase` is for momentary hold
// gestures (down → on, up → off). `arg` is an optional scalar payload (a mode name, a pad slot).
export type BoardApply = (deck: Deck, phase: "down" | "up" | undefined, arg: string | number | undefined) => void;

const registry = new Map<string, BoardApply>();

/** Register a board action by id. Call once at module load from wherever the control lives
 *  (so the FX knowledge stays in the FX module, etc.). Re-registering an id replaces it. */
export function registerBoardAction(id: string, apply: BoardApply): void {
  registry.set(id, apply);
}

/** Apply a received/replayed board gesture to a deck. Unknown ids are ignored (forward-compat:
 *  a newer recipe with an action this build doesn't know simply no-ops, never throws). */
export function applyBoardAction(deck: Deck, id: string, phase?: "down" | "up", arg?: string | number): boolean {
  const fn = registry.get(id);
  if (!fn) return false;
  fn(deck, phase, arg);
  return true;
}

// Pad mode (CUE / LOOP / SAMPLER / FX) — which 8-pad bank is live. A deck method, so it
// registers here directly. (FX-pad throws register from fxPads.ts; sampler from its module.)
registerBoardAction("padMode", (deck, _phase, arg) => {
  if (typeof arg === "string") deck.setPadMode(arg as PadMode);
});

// CENSOR — momentary reverse, slip-returning forward on release. A TRANSPORT gesture (a deck
// method, like padMode) since it moved off the FX pad bank to make room for the EQ pad, so it
// registers here rather than in fxPads. `down` = play backward, `up` = slip-snap to where the
// track would be. The keyboard has no key-up and drives it as a toggle, which arrives as the
// same down/up pair.
registerBoardAction("censor", (deck, phase) => {
  if (phase === "up") deck.censorEnd();
  else deck.censorBegin();
});

// SMART FADER's mode. The transition's audible moves cross as ordinary control intents (see
// smartFader.ts), but the MODE has to cross too: an armed throw pins key-lock off so the tempo
// morph pitches the decks turntable-style, and a far side that never pinned it would key-lock the
// glide away — the one part of the transition its own decks have to opt into rather than be told.
// It also lights the strip, so a co-DJ can see the fader is a transition and not a blend.
//
// The registry's unit is ONE deck and this mode is board-wide, so the sender emits it for both
// decks rather than this reaching across — a board action that quietly touched its neighbour would
// be a worse surprise than one extra message per arm.
//
// This is the FALLBACK registration: key-lock pinning only, which is the part that belongs to a
// deck. App.tsx re-registers over it with a version that also arms the receiving device's own
// SmartFader, so the mode is genuinely shared rather than half-applied — a strip that says SMART
// while the local fader would perform a plain crossfade is worse than one that says nothing.
registerBoardAction("smartFader", (deck, _phase, arg) => {
  deck.setKeylockPinnedOff(arg === "arm");
});

// ★ PERFORMANCE GESTURES THAT USED TO HAPPEN ON ONE DEVICE ONLY (operator, 2026-11-11: session sync
// audit). Each of these moved the deck's audio or playhead and emitted nothing, so on a guest the
// anchor's next tick yanked it back, and from the anchor a guest heard the gesture only as the tick
// dragged the follower along. They are deck methods, so they register here like `censor`.

// Hot-cue HOLD / CUE HOLD preview. `down` arg = the position to play from; `up` arg = the presser's
// slip setting (1/0), so the return lands where it did on the presser rather than by this device's
// own toggle. Shared, not a private audition: on a follower the preview moves the playhead the tick
// owns, so a gesture kept local is a gesture the tick undoes.
registerBoardAction("preview", (deck, phase, arg) => {
  if (phase === "up") deck.previewRelease(arg === undefined ? undefined : arg === 1 || arg === "1");
  else if (typeof arg === "number" && Number.isFinite(arg)) deck.previewHold(arg);
});

// Pitch BEND (lane drag / Shift-wheel, MIDI ring and non-vinyl platter). `arg` = the roll distance
// in seconds, summed per frame by the sender. Playing → a momentary nudge; paused → the same frame
// search the sender did (Deck.bend routes on the receiver's own play state, which the tick keeps
// equal). On a follower it is inert — its rate is the anchor's — and the anchor's bend reaches the
// follower through the tick's rate, so the gesture lands exactly once wherever it starts.
registerBoardAction("bend", (deck, _phase, arg) => {
  if (typeof arg === "number" && Number.isFinite(arg) && arg !== 0) deck.bend(arg);
});

// Spinback (arg = strength override; absent = the receiver's own length setting) and vinyl brake.
registerBoardAction("spinback", (deck, _phase, arg) => {
  deck.spinback(typeof arg === "number" ? arg : undefined);
});
registerBoardAction("brake", (deck) => {
  deck.releaseBrake();
});

// Sustained REVERSE (SHIFT + censor): runs backward until released. A `censor` up also stops a
// reverse (censorEnd = reverseStop), so a release may arrive as either.
registerBoardAction("reverse", (deck, phase) => {
  deck.setReverse(phase !== "up");
});
