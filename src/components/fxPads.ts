import type { Deck } from "@htl/audio";
import { registerBoardAction } from "@htl/board/boardActions";

// The deck's FX pad-mode bank ("Pad-FX") — 8 fixed performance effects over the one 8-pad
// bank (and the keyboard 1-8 when padMode === "fx"). The "Throws + Motion" shape:
//   row 1 (0-3) = effect THROWS:        ECHO  VERB  SAT   CRUSH
//   row 2 (4-7) = effect / transport:   MOD   CENS  GATE  SPIN
// (Target bank = …/ MOD CENS GATE NOISE; SPIN swaps out as NOISE lands → jog gesture.)
// `hold` effects fire on press and release on pointer-up (momentary); one-shots fire once.
// `enabled` dims a pad whose backend isn't ready (ECHO/VERB need a delay/reverb in the rack).
// `active` lights a sounding pad. One table, shared by DeckControls (render + pointer) and
// App (keyboard 1-8), so the mapping never forks.
export interface FxPadDef {
  label: string;
  hold: boolean; // true = momentary (down → on, up → off); false = one-shot trigger
  on: (d: Deck) => void;
  off?: (d: Deck) => void;
  enabled?: (d: Deck) => boolean; // absent = always enabled
  active?: (d: Deck) => boolean; // lights the pad while sounding
  hint: string;
}

export const FX_PADS: FxPadDef[] = [
  { label: "ECHO", hold: true, on: (d) => d.echoOut(true), off: (d) => d.echoOut(false), enabled: (d) => d.canEchoOut, active: (d) => d.echoingOut, hint: "Delay-tail throw — add a Delay to the rack to use" },
  { label: "VERB", hold: true, on: (d) => d.reverbOut(true), off: (d) => d.reverbOut(false), enabled: (d) => d.canReverbOut, active: (d) => d.reverbingOut, hint: "Reverb-tail throw — add a Reverb to the rack to use" },
  { label: "SAT", hold: true, on: (d) => d.satThrow(true), off: (d) => d.satThrow(false), enabled: (d) => d.canSatThrow, active: (d) => d.satThrowing, hint: "Saturation slam — add a Saturator to the rack to use" },
  { label: "CRUSH", hold: true, on: (d) => d.crushThrow(true), off: (d) => d.crushThrow(false), enabled: (d) => d.canCrushThrow, active: (d) => d.crushThrowing, hint: "Bitcrush smash — add a Bitcrusher to the rack to use" },
  { label: "MOD", hold: true, on: (d) => d.modThrow(true), off: (d) => d.modThrow(false), enabled: (d) => d.canModThrow, active: (d) => d.modThrowing, hint: "Modulation swirl — add a Modulation device to the rack to use" },
  { label: "CENS", hold: true, on: (d) => d.censorBegin(), off: (d) => d.censorEnd(), active: (d) => d.reversing, hint: "Censor — reverse, slip-return on release" },
  { label: "GATE", hold: true, on: (d) => d.gateThrow(true), off: (d) => d.gateThrow(false), enabled: (d) => d.canGateThrow, active: (d) => d.gateThrowing, hint: "Trance-gate stutter — add a Gate to the rack to use" },
  { label: "SPIN", hold: false, on: (d) => d.spinback(), hint: "Backspin" },
];

/** Fire an FX pad (keyboard/MIDI 1-8 in fx mode). `on` = key down (press), false = key up. */
export function fireFxPad(deck: Deck, slot: number, on: boolean): void {
  const pad = FX_PADS[slot];
  if (!pad) return;
  if (pad.enabled && !pad.enabled(deck)) return;
  if (on) pad.on(deck);
  else pad.off?.(deck);
}

// Sync + replay over the board-agnostic gesture bus: a recorded/relayed "fxPad" gesture applies
// by slot index, so any pad added to FX_PADS above is covered with no protocol/applyIntent edit.
registerBoardAction("fxPad", (deck, phase, arg) => fireFxPad(deck, Number(arg), phase !== "up"));
