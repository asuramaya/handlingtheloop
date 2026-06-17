// The catalog of controls a user can MIDI-Learn onto a generic / custom board.
// Each entry is a concrete control instance (per-deck ones are listed twice) with
// the normalized ControlSpec it drives. The settings UI renders these as "click,
// then wiggle the hardware" rows; a capture writes a LearnedBinding keyed by `id`.

import type { ControlSpec, DeckId, FaderTarget } from "./types";

export interface LearnControl {
  id: string; // stable key into the learn map
  label: string;
  group: string;
  deck?: DeckId;
  control: ControlSpec;
}

function perDeck(base: string, label: string, group: string, control: (deck: DeckId) => ControlSpec): LearnControl[] {
  return (["A", "B"] as DeckId[]).map((deck) => ({
    id: `${base}.${deck}`,
    label: `${label} — Deck ${deck}`,
    group,
    deck,
    control: control(deck),
  }));
}

const action = (a: string): ControlSpec => ({ kind: "action", action: a });
const fader = (target: FaderTarget): ControlSpec => ({ kind: "fader", target });

export const LEARN_CONTROLS: LearnControl[] = [
  // Transport
  ...perDeck("play", "Play / Pause", "Transport", () => action("play")),
  ...perDeck("cue", "Cue", "Transport", () => action("cue")),
  ...perDeck("sync", "Sync", "Transport", () => action("sync")),
  // Loop
  ...perDeck("loopIn", "Loop In", "Loop", () => action("loopIn")),
  ...perDeck("loopOut", "Loop Out", "Loop", () => action("loopOut")),
  ...perDeck("loopExit", "Reloop / Exit", "Loop", () => action("loopExit")),
  // Mixer (faders / knobs)
  ...perDeck("tempo", "Tempo fader", "Mixer", () => fader("tempo")),
  ...perDeck("level", "Channel fader", "Mixer", () => fader("level")),
  ...perDeck("trim", "Trim / Gain", "Mixer", () => fader("trim")),
  ...perDeck("eqHi", "EQ High", "Mixer", () => fader("eqHi")),
  ...perDeck("eqMid", "EQ Mid", "Mixer", () => fader("eqMid")),
  ...perDeck("eqLow", "EQ Low", "Mixer", () => fader("eqLow")),
  ...perDeck("filter", "Filter / Colour", "Mixer", () => fader("filter")),
  ...perDeck("pitch", "Pitch / Key", "Mixer", () => fader("pitch")),
  { id: "crossfader", label: "Crossfader", group: "Mixer", control: { kind: "fader", target: "crossfader" } },
  // Stems (per-stem level)
  ...perDeck("stemDrums", "Stem — Drums", "Stems", () => fader("stemDrums")),
  ...perDeck("stemBass", "Stem — Bass", "Stems", () => fader("stemBass")),
  ...perDeck("stemVocals", "Stem — Vocals", "Stems", () => fader("stemVocals")),
  ...perDeck("stemOther", "Stem — Inst", "Stems", () => fader("stemOther")),
  // Jog
  ...perDeck("jogTouch", "Jog touch", "Jog", () => ({ kind: "jogTouch" })),
  ...perDeck("jogTurn", "Jog turn (scratch)", "Jog", () => ({ kind: "jogTurn" })),
  ...perDeck("jogBend", "Jog bend (outer ring)", "Jog", () => ({ kind: "jogBend" })),
  ...perDeck("jogSearch", "Jog search (shift+jog)", "Jog", () => ({ kind: "jogSearch" })),
  ...perDeck("spinback", "Spinback (back-spin)", "Jog", () => action("spinback")),
  ...perDeck("jogBack", "Nudge back (grid)", "Jog", () => action("jogBack")),
  ...perDeck("jogFwd", "Nudge forward (grid)", "Jog", () => action("jogFwd")),
  // Browse / zoom encoders (relative)
  ...perDeck("zoom", "Waveform zoom", "Jog", () => ({ kind: "zoom" })),
  { id: "browse", label: "Library scroll", group: "Modifier", control: { kind: "browse" } },
  { id: "selector", label: "Library open/close", group: "Modifier", control: { kind: "selector" } },
  // Shift modifier (per deck)
  ...perDeck("shift", "Shift", "Modifier", () => ({ kind: "shift" })),
  // Deck focus — for pad-style boards that drive one deck at a time (A/B switch)
  ...perDeck("focus", "Focus deck", "Modifier", (deck) => ({ kind: "focus", deck })),
  // Hot cues 1..8
  ...Array.from({ length: 8 }, (_, i) => i + 1).flatMap((n) => perDeck(`hotcue${n}`, `Hot cue ${n}`, "Hot cues", () => action(`hotcue${n}`))),
  // Sampler strip pads 1..12 — GLOBAL (not per-deck): the strip routes each by position
  // (1-4 → deck A, 5-8 → master, 9-12 → deck B), so a pad is one learnable action.
  ...Array.from({ length: 12 }, (_, i) => ({ id: `sampler${i}`, label: `Sampler pad ${i + 1}`, group: "Sampler", control: action(`sampler${i}`) })),
];

export const LEARN_GROUPS = ["Transport", "Loop", "Mixer", "Stems", "Jog", "Modifier", "Hot cues", "Sampler"];

export function learnControl(id: string): LearnControl | undefined {
  return LEARN_CONTROLS.find((c) => c.id === id);
}
