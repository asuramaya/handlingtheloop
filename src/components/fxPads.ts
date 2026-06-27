import type { Deck, FxKind } from "@htl/audio";
import { registerBoardAction } from "@htl/board/boardActions";

// The deck's FX pad-mode bank ("Pad-FX") — 8 fixed performance effects over the one 8-pad
// bank (and the keyboard 1-8 when padMode === "fx"). The "Throws + Motion" shape:
//   row 1 (0-3) = effect THROWS:        ECHO  VERB  SAT   CRUSH
//   row 2 (4-7) = effects:              MOD   CENS  GATE  NOISE
// (The bank is complete — BRAKE/SPIN dropped to jog gestures as GATE/NOISE landed.)
// Every backing device is a PERMANENT resident of the rack (provisioned dormant on deck birth,
// see Deck.ensurePadFx), so all 8 pads are ALWAYS armed — no "add a Delay first" gating. `hold`
// effects fire on press and release on pointer-up (momentary). `kind` is the pad's backing rack
// device, so a right-click can reveal its control surface (absent = no device, e.g. CENS, which
// is transport-reverse). `active` lights a sounding pad. One table, shared by DeckControls
// (render + pointer) and App (keyboard 1-8), so the mapping never forks.
export interface FxPadDef {
  label: string;
  kind?: FxKind; // backing rack device, for "reveal its panel" (absent = no panel, e.g. CENS)
  hold: boolean; // true = momentary (down → on, up → off); false = one-shot trigger
  on: (d: Deck) => void;
  off?: (d: Deck) => void;
  active?: (d: Deck) => boolean; // lights the pad while sounding
  hint: string;
}

export const FX_PADS: FxPadDef[] = [
  { label: "ECHO", kind: "delay", hold: true, on: (d) => d.echoOut(true), off: (d) => d.echoOut(false), active: (d) => d.echoingOut, hint: "Delay-tail throw — repeats ring out on release" },
  { label: "VERB", kind: "reverb", hold: true, on: (d) => d.reverbOut(true), off: (d) => d.reverbOut(false), active: (d) => d.reverbingOut, hint: "Reverb-tail throw — the tail blooms on release" },
  { label: "SAT", kind: "saturator", hold: true, on: (d) => d.satThrow(true), off: (d) => d.satThrow(false), active: (d) => d.satThrowing, hint: "Saturation slam — drive boost while held" },
  { label: "CRUSH", kind: "crush", hold: true, on: (d) => d.crushThrow(true), off: (d) => d.crushThrow(false), active: (d) => d.crushThrowing, hint: "Bitcrush smash — bit/rate crush while held" },
  { label: "MOD", kind: "mod", hold: true, on: (d) => d.modThrow(true), off: (d) => d.modThrow(false), active: (d) => d.modThrowing, hint: "Modulation swirl — depth boost while held" },
  { label: "CENS", hold: true, on: (d) => d.censorBegin(), off: (d) => d.censorEnd(), active: (d) => d.reversing, hint: "Censor — reverse, slip-return on release" },
  { label: "GATE", kind: "gate", hold: true, on: (d) => d.gateThrow(true), off: (d) => d.gateThrow(false), active: (d) => d.gateThrowing, hint: "Trance-gate stutter while held" },
  { label: "NOISE", kind: "noise", hold: true, on: (d) => d.noiseThrow(true), off: (d) => d.noiseThrow(false), active: (d) => d.noiseThrowing, hint: "Noise riser — sweep up while held, cut on release" },
];

/** Fire an FX pad (keyboard/MIDI 1-8 in fx mode). `on` = key down (press), false = key up. */
export function fireFxPad(deck: Deck, slot: number, on: boolean): void {
  const pad = FX_PADS[slot];
  if (!pad) return;
  if (on) pad.on(deck);
  else pad.off?.(deck);
}

// Sync + replay over the board-agnostic gesture bus: a recorded/relayed "fxPad" gesture applies
// by slot index, so any pad added to FX_PADS above is covered with no protocol/applyIntent edit.
registerBoardAction("fxPad", (deck, phase, arg) => fireFxPad(deck, Number(arg), phase !== "up"));
