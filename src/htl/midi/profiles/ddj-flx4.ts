// Pioneer / AlphaTheta DDJ-FLX4 profile.
//
// The FLX4 is a class-compliant USB-MIDI device (no driver) so Web MIDI reads it
// directly — BUT it stays half-asleep until it receives a SysEx handshake, which
// must then be repeated as a keep-alive. Numbers below are from the community
// Mixxx mapping (Pioneer-DDJ-FLX4.midi.xml / -script.js), cross-checked with the
// vendor MIDI message list. Deck 1 = MIDI channel 1, Deck 2 = channel 2.
//
//   Note status:  deck A 0x90, deck B 0x91
//   CC status:    deck A 0xB0, deck B 0xB1, mixer-global 0xB6
//   Pad status:   deck A 0x97, deck B 0x99 (unshifted)
//
// Faders/EQ are 14-bit (MSB on the listed CC, LSB on CC + 0x20). Most numbers are
// verified from the Mixxx map; a few (SHIFT note, browse press) are best-effort and
// can be re-mapped via MIDI-Learn if a unit differs.

import type { DeviceProfile, MidiBinding } from "../types";

// Pioneer "keep-alive" / wake handshake — reverse-engineered by the Mixxx project.
// 0x00 0x40 is the AlphaTheta manufacturer id. Sent on connect, then every 200 ms.
const FLX4_HANDSHAKE = [0xf0, 0x00, 0x40, 0x05, 0x00, 0x00, 0x04, 0x05, 0x00, 0x50, 0x02, 0xf7];

const NOTE_A = 0x90;
const NOTE_B = 0x91;
const CC_A = 0xb0;
const CC_B = 0xb1;
const CC_MIX = 0xb6;
const PAD_A = 0x97;
const PAD_B = 0x99;

// Per-deck button (note). press/release decoded from velocity.
function btn(action: string, data: number): MidiBinding[] {
  return [
    { control: { kind: "action", action }, deck: "A", status: NOTE_A, data, type: "note" },
    { control: { kind: "action", action }, deck: "B", status: NOTE_B, data, type: "note" },
  ];
}

// A button's SHIFTED variant — a different note on the same status (Pioneer assigns
// these per-button, no universal offset). Dispatched as the action with shift forced.
function shiftedBtn(action: string, data: number): MidiBinding[] {
  return [
    { control: { kind: "action", action }, deck: "A", status: NOTE_A, data, type: "note", shift: true },
    { control: { kind: "action", action }, deck: "B", status: NOTE_B, data, type: "note", shift: true },
  ];
}

// Per-deck 14-bit knob/fader (CC). `invert` flips direction (Pioneer pitch fader
// reads max at the top = slowest).
function knob(target: "tempo" | "level" | "trim" | "eqHi" | "eqMid" | "eqLow" | "filter", data: number, invert = false): MidiBinding[] {
  return [
    { control: { kind: "fader", target, invert }, deck: "A", status: CC_A, data, type: "cc14" },
    { control: { kind: "fader", target, invert }, deck: "B", status: CC_B, data, type: "cc14" },
  ];
}

// FLX4 hot-cue pads (mode default) — pads 1..8 on data 0x00..0x07.
function hotcuePads(): MidiBinding[] {
  const out: MidiBinding[] = [];
  for (let i = 0; i < 8; i++) {
    out.push({ control: { kind: "action", action: `hotcue${i + 1}` }, deck: "A", status: PAD_A, data: 0x00 + i, type: "note" });
    out.push({ control: { kind: "action", action: `hotcue${i + 1}` }, deck: "B", status: PAD_B, data: 0x00 + i, type: "note" });
  }
  return out;
}

// Beat-loop pads — FLX4 sizes 0.25,0.5,1,2,4,8,16,32 beats on data 0x60..0x67.
// Mapped onto our beat-loop ladder (1/16…8); the two largest clamp to 8.
function beatLoopPads(): MidiBinding[] {
  const ours = ["beatLoop2", "beatLoop3", "beatLoop4", "beatLoop5", "beatLoop6", "beatLoop7", "beatLoop7", "beatLoop7"];
  const out: MidiBinding[] = [];
  for (let i = 0; i < 8; i++) {
    out.push({ control: { kind: "action", action: ours[i] }, deck: "A", status: PAD_A, data: 0x60 + i, type: "note" });
    out.push({ control: { kind: "action", action: ours[i] }, deck: "B", status: PAD_B, data: 0x60 + i, type: "note" });
  }
  return out;
}

// Beat-jump pads — data 0x20..0x27 → −1,+1,−2,+2,−4,+4,−8,+8 beats.
function beatJumpPads(): MidiBinding[] {
  const beats = [-1, 1, -2, 2, -4, 4, -8, 8];
  const out: MidiBinding[] = [];
  for (let i = 0; i < 8; i++) {
    out.push({ control: { kind: "beatjump", beats: beats[i] }, deck: "A", status: PAD_A, data: 0x20 + i, type: "note" });
    out.push({ control: { kind: "beatjump", beats: beats[i] }, deck: "B", status: PAD_B, data: 0x20 + i, type: "note" });
  }
  return out;
}

export const DDJ_FLX4: DeviceProfile = {
  id: "ddj-flx4",
  name: "Pioneer DDJ-FLX4",
  match: ["ddj-flx4", "ddj flx4", "flx4"],
  bindings: [
    // Transport
    ...btn("play", 0x0b),
    ...btn("cue", 0x0c),
    ...btn("sync", 0x58),
    // Loop
    ...btn("loopIn", 0x10),
    ...btn("loopOut", 0x11),
    ...btn("loopExit", 0x4d), // RELOOP toggle
    // Shifted loop buttons (different notes on the same status, verified via monitor):
    // IN 0x4C → arm loop-in adjust, OUT 0x4E → arm loop-out adjust, EXIT 0x50 → clear loop.
    ...shiftedBtn("loopIn", 0x4c),
    ...shiftedBtn("loopOut", 0x4e),
    ...shiftedBtn("loopExit", 0x50),
    // Shifted transport (monitor: shift+CUE 0x48 → jump to start, shift+PLAY 0x0E → reset).
    ...shiftedBtn("cue", 0x48),
    ...shiftedBtn("play", 0x0e),
    // CUE/LOOP-CALL ◀ ▶ → jogBack/jogFwd, which already JUMP when unshifted and MOVE THE
    // LOOP when shifted (same as ↑/↓ vs shift+↑/↓). The FLX4 sends a different note under
    // shift (0x51→0x60, 0x53→0x61), so we map both with LIVE shift: the unshifted notes
    // fire with shift off (jump), the shifted notes fire while SHIFT is held (move loop).
    ...btn("jogBack", 0x51), // ◀ unshifted → jump back
    ...btn("jogFwd", 0x53), //  ▶ unshifted → jump forward
    ...btn("jogFwd", 0x3d), //  shifted (fires while SHIFT held) → move loop forward
    ...btn("jogBack", 0x3e), // shifted → move loop back
    // Shifted SYNC/MASTER button (note 0x60) → HTL KEY (key-match). KEY ignores shift,
    // so force shift:false or the held SHIFT would suppress it.
    { control: { kind: "action", action: "keyMatch" }, deck: "A", status: NOTE_A, data: 0x60, type: "note", shift: false },
    { control: { kind: "action", action: "keyMatch" }, deck: "B", status: NOTE_B, data: 0x60, type: "note", shift: false },
    // SHIFT button (per deck, note 0x3F — verified on hardware via the MIDI monitor).
    // A plain momentary modifier: the FLX4 keeps sending each button's normal note while
    // SHIFT is held, so HTL's own shift logic applies the alt action (shift+cue clears
    // the cue, shift+jog moves the loop, etc.).
    { control: { kind: "shift" }, deck: "A", status: NOTE_A, data: 0x3f, type: "note" },
    { control: { kind: "shift" }, deck: "B", status: NOTE_B, data: 0x3f, type: "note" },
    // Faders / knobs (14-bit). Tempo fader: NOT inverted — push up → faster, matching
    // the on-screen tempo cell + how the FLX4 actually reports its pitch fader here.
    ...knob("tempo", 0x00, false),
    ...knob("level", 0x13),
    ...knob("trim", 0x04),
    ...knob("eqHi", 0x07),
    ...knob("eqMid", 0x0b),
    ...knob("eqLow", 0x0f),
    // SMART CFX (filter) knobs — PER DECK, both on the mixer channel as 14-bit CCs:
    // deck A MSB 0x17, deck B MSB 0x18. Centre = off, right = high-pass, left = low-pass.
    { control: { kind: "fader", target: "filter" }, deck: "A", status: CC_MIX, data: 0x17, type: "cc14" },
    { control: { kind: "fader", target: "filter" }, deck: "B", status: CC_MIX, data: 0x18, type: "cc14" },
    // Crossfader (mixer-global, 14-bit)
    { control: { kind: "fader", target: "crossfader" }, status: CC_MIX, data: 0x1f, type: "cc14" },
    // Jog wheels — the FLX4 top plate is capacitive and the hardware VINYL button
    // decides scratch-vs-bend by switching which CC the top emits (verified against the
    // Mixxx mapping). Four streams:
    //   TOUCH (top capacitive sensor, note 0x36) — grab; only meaningful in vinyl mode.
    //   TOP TURN, Vinyl ON  → CC 0x22 → SCRATCH (jogTurn scratch:true).
    //   TOP TURN, Vinyl OFF → CC 0x23 → BEND   (jogTurn scratch:false) — was UNMAPPED.
    //   OUTER RING (never touched) → CC 0x21 → BEND (jogBend), always.
    // App latches vinyl-mode from whether 0x22 or 0x23 is arriving and gates the grab
    // (so a touch in non-vinyl mode no longer stops the deck dead).
    { control: { kind: "jogTouch" }, deck: "A", status: NOTE_A, data: 0x36, type: "note" },
    { control: { kind: "jogTouch" }, deck: "B", status: NOTE_B, data: 0x36, type: "note" },
    { control: { kind: "jogTurn", scratch: true }, deck: "A", status: CC_A, data: 0x22, type: "cc" },
    { control: { kind: "jogTurn", scratch: true }, deck: "B", status: CC_B, data: 0x22, type: "cc" },
    { control: { kind: "jogTurn", scratch: false }, deck: "A", status: CC_A, data: 0x23, type: "cc" },
    { control: { kind: "jogTurn", scratch: false }, deck: "B", status: CC_B, data: 0x23, type: "cc" },
    { control: { kind: "jogBend" }, deck: "A", status: CC_A, data: 0x21, type: "cc" },
    { control: { kind: "jogBend" }, deck: "B", status: CC_B, data: 0x21, type: "cc" },
    // SHIFT + top turn → fast search/scan. The FLX4 sends this on its own CC (0x29),
    // already shift-resolved in hardware, so no software shift gate is needed (same as
    // the shifted loop buttons). App routes it to a fast seek through the track.
    { control: { kind: "jogSearch" }, deck: "A", status: CC_A, data: 0x29, type: "cc" },
    { control: { kind: "jogSearch" }, deck: "B", status: CC_B, data: 0x29, type: "cc" },
    // Browse encoder: rotate (relative) + PRESS (the selector) + load buttons
    { control: { kind: "browse" }, status: CC_MIX, data: 0x40, type: "cc" },
    { control: { kind: "selector" }, status: 0x96, data: 0x41, type: "note" },
    { control: { kind: "load" }, deck: "A", status: 0x96, data: 0x46, type: "note" },
    { control: { kind: "load" }, deck: "B", status: 0x96, data: 0x47, type: "note" },
    // Performance pads
    ...hotcuePads(),
    ...beatLoopPads(),
    ...beatJumpPads(),
  ],
  noteStatus: { A: NOTE_A, B: NOTE_B },
  padStatus: { A: PAD_A, B: PAD_B },
  feedback: {
    play: 0x0b,
    cue: 0x0c,
    sync: 0x58,
    loop: 0x4d,
    hotcues: [0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07],
  },
  initSysex: FLX4_HANDSHAKE,
  keepAliveMs: 200,
};
