// Donner Starrypad profile.
//
// The Starrypad is a class-compliant USB-MIDI PAD controller (16 RGB pads, knobs,
// transport) — NOT a two-deck DJ board. So unlike the FLX4 it doesn't duplicate
// controls per deck; instead ONE control set drives whichever deck is FOCUSED, and
// a pair of buttons switches that focus (an A/B switch). Its buttons report as CC
// (0xB0 cc, 0x7F = press / 0x00 = release), not notes.
//
// Verified via the in-app MIDI monitor (Settings ▸ MIDI):
//   CC 0x1A → focus Deck A
//   CC 0x1B → focus Deck B
// The rest of the surface (pads, transport, knobs) is captured the same way and
// added below as it's confirmed; until then those controls fall back to MIDI-Learn.

import type { DeviceProfile, FaderTarget, MidiBinding } from "../types";

const CC = 0xb0; // the Starrypad sends on MIDI channel 1
const PAD = 0x99; // pads: note-on ch10 (0x99) on press / note-off (0x89) on release

// A focus button: a CC button (press 0x7F / release 0x00) that makes `deck` the
// focused deck the whole controller drives.
function focusBtn(deck: "A" | "B", data: number): MidiBinding {
  return { control: { kind: "focus", deck }, status: CC, data, type: "cc" };
}

// The 16 pads (notes 0x5C..0x6B, contiguous): 1-8 = hot cues, 9-16 = the 8 beat-loop
// sizes. Deckless → focused deck. (Note-off 0x89 misses the 0x99 index = a clean no-op,
// since pads act on press.)
function padBindings(): MidiBinding[] {
  const out: MidiBinding[] = [];
  for (let i = 0; i < 8; i++) out.push({ control: { kind: "action", action: `hotcue${i + 1}` }, status: PAD, data: 0x5c + i, type: "note" });
  for (let i = 0; i < 8; i++) out.push({ control: { kind: "action", action: `beatLoop${i}` }, status: PAD, data: 0x64 + i, type: "note" });
  return out;
}

// A value knob. The Starrypad's rotaries spin forever but the firmware reports a BOUNDED
// ABSOLUTE 0..127 that clamps AND goes silent at the rails — so it can't be delta-tracked
// to its extremes (you'd get stuck). `pickup` treats it as absolute with soft-takeover:
// no jump until the knob sweeps through the current value, then 1:1 (reaches 0/max). No
// `deck` → drives the FOCUSED deck.
function knob(target: FaderTarget, data: number): MidiBinding {
  return { control: { kind: "fader", target, pickup: true }, status: CC, data, type: "cc" };
}

// Plain ABSOLUTE knob (no pickup). For the filter, whose amount starts at 0: pickup
// would only "catch" when the knob reaches the very bottom, so it'd feel dead — and a
// filter jump is harmless (unlike a volume jump), so map it straight through.
function absKnob(target: FaderTarget, data: number): MidiBinding {
  return { control: { kind: "fader", target }, status: CC, data, type: "cc" };
}

// RELATIVE knob — for tempo/pitch, which SYNC/KEY/the session master move on their own.
// Pickup's catch goes stale whenever the value shifts externally (the knob then "doesn't
// respond" until you sweep back across it); a relative nudge from the CURRENT value always
// responds. The small range means the bounded encoder rarely rails before its limit.
function relKnob(target: FaderTarget, data: number): MidiBinding {
  return { control: { kind: "fader", target, relative: true }, status: CC, data, type: "cc" };
}

// A relative encoder that step-jogs like the arrow keys: each detent fires `forward`
// (turn right) or `backward` (turn left) on the focused deck. Deckless → focused.
function enc(forward: string, backward: string, data: number): MidiBinding {
  return { control: { kind: "encoderAction", forward, backward }, status: CC, data, type: "cc" };
}

// A CC button (7F press / 00 release) bound to a transport action. Deckless → focused.
function actionBtn(action: string, data: number): MidiBinding {
  return { control: { kind: "action", action }, status: CC, data, type: "cc" };
}

export const DONNER_STARRYPAD: DeviceProfile = {
  id: "donner-starrypad",
  name: "Donner Starrypad",
  match: ["starrypad", "donner"],
  bindings: [
    // A/B focus switch — one control set, two decks (verified bytes).
    focusBtn("A", 0x1a),
    focusBtn("B", 0x1b),
    // Endless knobs (relative) → mixer + stems + pitch/tempo of the focused deck.
    knob("level", 0x14),
    knob("trim", 0x15),
    knob("stemDrums", 0x16),
    knob("stemBass", 0x17),
    knob("stemVocals", 0x18),
    knob("stemOther", 0x19),
    relKnob("tempo", 0x1c), // relative: SYNC moves tempo, so pickup would go stale
    relKnob("pitch", 0x09), // relative: KEY moves pitch, so pickup would go stale
    // Filter — two INDEPENDENT knobs (band-pass possible). Plain absolute (not pickup).
    // Swapped vs first guess: 0x0C is HP, 0x0D is LP.
    absKnob("filterHp", 0x0c), // HP (high-pass) amount
    absKnob("filterLp", 0x0d), // LP (low-pass) amount
    // Step-jog encoders → arrow-key behaviour (grid nudge; shift = move loop, in parity).
    enc("jogFwdBeat", "jogBackBeat", 0x0e), // left / right (a beat at a time)
    enc("jogFwd", "jogBack", 0x0f), // up / down (skip-size jump)
    // Transport — CC button on the focused deck.
    actionBtn("play", 0x3c), // PLAY
    // RECORD is a LATCHING hardware toggle (7F on / 00 off) → use it as a shift latch
    // for the focused deck.
    { control: { kind: "shift" }, status: CC, data: 0x3e, type: "cc" },
    // 16 pads: 1-8 hot cues, 9-16 beat loops.
    ...padBindings(),
  ],
};
