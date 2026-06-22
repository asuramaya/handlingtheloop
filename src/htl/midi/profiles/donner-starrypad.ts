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

// The 16 pads report as note-on (0x99 press / 0x89 release) over a SPLIT range —
// 0x3A..0x3F then 0x40..0x49 (verified via the in-app MIDI monitor; the first guess at
// 0x5C was wrong). Deckless → focused deck; pads act on press (note-off is a clean no-op).
// Layout:
//   1-8   → the mode-routed pad triggers (hotcue1..8 — App routes by the deck's pad mode:
//           hot cue / beat loop / sampler region / FX throw, so the bank follows CUE/LOOP/SMP/FX)
//   9-12  → pad-mode switch: CUE / LOOP / SMP / FX
//   13-14 → loop IN / loop OUT
//   15-16 → up / down grid-locked nudges (skip-size, same as the ↑/↓ arrow keys)
const PAD_NOTES = [0x3a, 0x3b, 0x3c, 0x3d, 0x3e, 0x3f, 0x40, 0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49];

function padNote(action: string, slot: number): MidiBinding {
  return { control: { kind: "action", action }, status: PAD, data: PAD_NOTES[slot], type: "note" };
}

function padBindings(): MidiBinding[] {
  const out: MidiBinding[] = [];
  for (let i = 0; i < 8; i++) out.push(padNote(`hotcue${i + 1}`, i)); // 1-8 · mode-routed pad triggers
  out.push(padNote("padModeCue", 8)); // 9
  out.push(padNote("padModeLoop", 9)); // 10
  out.push(padNote("padModeSampler", 10)); // 11
  out.push(padNote("padModeFx", 11)); // 12
  out.push(padNote("loopIn", 12)); // 13
  out.push(padNote("loopOut", 13)); // 14
  out.push(padNote("jogFwd", 14)); // 15 · ↑ grid-locked skip
  out.push(padNote("jogBack", 15)); // 16 · ↓ grid-locked skip
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
    // 16 pads: 1-8 mode-routed triggers, 9-12 mode switch, 13-14 loop in/out, 15-16 nudge.
    ...padBindings(),
  ],
};
