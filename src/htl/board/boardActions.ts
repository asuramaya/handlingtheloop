import type { Deck } from "@htl/audio";

type PadMode = "cue" | "loop" | "sampler" | "fx";

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
