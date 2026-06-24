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

// Performance pads. Each UNSHIFTED bank emits its own contiguous block of 8 notes on the
// pad status (deck A 0x97 / deck B 0x99): HOT CUE 0x00, BEAT JUMP 0x20, SAMPLER 0x30,
// PAD FX1 0x40 (verified on hardware + the Mixxx FLX4 map). We deliberately do NOT bind a
// bank to a fixed action — the FLX bank stays in lock-step with HTL's pad mode (the bank
// buttons switch both), so EVERY block maps the same way the keyboard 1-8 do: pad position
// i → `hotcue${i+1}`, the single generic handler that routes by the deck's pad mode
// (cue → hot cue, loop → beat-loop size, sampler → region pad, fx → Pad-FX). One source of
// truth means switching banks can never desync the pad's action from the on-screen mode.
const PAD_BANKS = [0x00, 0x20, 0x30, 0x40];
function padBanks(): MidiBinding[] {
  const out: MidiBinding[] = [];
  for (const base of PAD_BANKS)
    for (let i = 0; i < 8; i++) {
      out.push({ control: { kind: "action", action: `hotcue${i + 1}` }, deck: "A", status: PAD_A, data: base + i, type: "note" });
      out.push({ control: { kind: "action", action: `hotcue${i + 1}` }, deck: "B", status: PAD_B, data: base + i, type: "note" });
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
    // Performance-pad MODE buttons → HTL pad banks. The FLX4's four UNSHIFTED bank-select
    // buttons (note status, deck A 0x90 / deck B 0x91) switch which pad mode that DECK shows,
    // positionally 1:1 with our on-screen CUE · FX · LOOP · SMP row. Notes from the Mixxx map:
    //   HOT CUE 0x1B → cue · PAD FX1 0x1E → fx · BEAT JUMP 0x20 → loop · SAMPLER 0x22 → sampler.
    // (loop sits on the unshifted BEAT JUMP, not the shifted BEAT LOOP 0x6D, so all four live
    //  on the buttons you actually press — and the four LEDs the firmware toggles.)
    ...btn("padModeCue", 0x1b),
    ...btn("padModeFx", 0x1e),
    ...btn("padModeLoop", 0x20),
    ...btn("padModeSampler", 0x22),
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
    ...knob("eqHi", 0x07),
    ...knob("eqMid", 0x0b),
    ...knob("eqLow", 0x0f),
    // NO per-channel TRIM/gain knob on the FLX4. The COLOR/filter knob DUPLICATES its output
    // on the deck channel CC 0x04 (LSB 0x24) AND the mixer CC 0x17/0x18 (verified live: one
    // knob emits BOTH `B0 04` and `B6 17`). Binding 0x04 to "trim" made the filter knob drag
    // trim too — so we map only the mixer-channel pair below and leave 0x04 unbound.
    // SMART CFX (filter) knobs — PER DECK on the mixer channel as 14-bit CCs:
    // deck A MSB 0x17, deck B MSB 0x18. Centre = off, right = high-pass, left = low-pass.
    { control: { kind: "fader", target: "filter" }, deck: "A", status: CC_MIX, data: 0x17, type: "cc14" },
    { control: { kind: "fader", target: "filter" }, deck: "B", status: CC_MIX, data: 0x18, type: "cc14" },
    // Crossfader (mixer-global, 14-bit)
    { control: { kind: "fader", target: "crossfader" }, status: CC_MIX, data: 0x1f, type: "cc14" },
    // Left-column knobs (mixer-global, 14-bit — all verified on hardware; the Mixxx map
    // omitted the two LEVEL knobs but this firmware does transmit them):
    //   MIC LEVEL  MSB 0x05 → mic input level   🎧 MIX  MSB 0x0C → CUE↔MST blend
    //   🎧 LEVEL   MSB 0x0D → headphone master level
    { control: { kind: "fader", target: "micLevel" }, status: CC_MIX, data: 0x05, type: "cc14" },
    { control: { kind: "fader", target: "cueMix" }, status: CC_MIX, data: 0x0c, type: "cc14" },
    { control: { kind: "fader", target: "cueLevel" }, status: CC_MIX, data: 0x0d, type: "cc14" },
    // SMART CFX (0x96/0x00) → toggle the HI/MID/LOW knobs between EQ and STEM volume.
    // SMART FADER (0x96/0x01) → enable/disable the crossfader + recentre.
    // NOTE: if these are swapped on your unit, swap the two data bytes.
    { control: { kind: "action", action: "eqStemToggle" }, status: 0x96, data: 0x00, type: "note" },
    { control: { kind: "action", action: "xfaderToggle" }, status: 0x96, data: 0x01, type: "note" },
    // BEAT FX section (all verified on hardware). The section drives the FOCUSED deck; the
    // 1·2 switch moves focus. LEVEL/DEPTH (14-bit, MSB 0x02 / LSB 0x22 — also mirrored on 0xB5,
    // which we ignore) → selected-FX wet/dry. FX SELECT (one button) toggles add-mode + commits;
    // BEAT ◀▶ nav the selected tab (or the add candidate); ON/OFF bypasses; SMART CFX resets.
    { control: { kind: "fader", target: "fxWetDry" }, status: 0xb4, data: 0x02, type: "cc14" },
    { control: { kind: "action", action: "fxBypassCur" }, status: 0x94, data: 0x47, type: "note" },
    // The ON/OFF (RELEASE FX) button has a firmware-toggled lamp; in its "lit" internal state it
    // transmits the press on channel 0x95 instead of 0x94 (seen live after the lamp was driven).
    // Bind BOTH channel states so bypass fires no matter which state the firmware is parked in.
    { control: { kind: "action", action: "fxBypassCur" }, status: 0x95, data: 0x47, type: "note" },
    { control: { kind: "action", action: "fxBypassCur" }, status: 0x95, data: 0x43, type: "note", shift: true },
    { control: { kind: "action", action: "fxSelectPress" }, status: 0x94, data: 0x63, type: "note" },
    { control: { kind: "action", action: "fxSelPrev" }, status: 0x94, data: 0x4a, type: "note" },
    { control: { kind: "action", action: "fxSelNext" }, status: 0x94, data: 0x4b, type: "note" },
    // SHIFTED layer — the FLX sends its OWN notes when SHIFT is held (verified), so they carry
    // shift:true and hit the shifted branch of the same handlers: remove / reorder / reset.
    { control: { kind: "action", action: "fxSelectPress" }, status: 0x94, data: 0x64, type: "note", shift: true },
    { control: { kind: "action", action: "fxSelPrev" }, status: 0x94, data: 0x66, type: "note", shift: true },
    { control: { kind: "action", action: "fxSelNext" }, status: 0x94, data: 0x6b, type: "note", shift: true },
    { control: { kind: "action", action: "fxBypassCur" }, status: 0x94, data: 0x43, type: "note", shift: true },
    // 1·2·1&2 channel switch — pos 1 (note 0x94/0x10) → focus deck A, pos 2 (0x95/0x11) → deck B.
    // At 1&2 both notes fire; last wins for now (true "both" is deferred).
    { control: { kind: "focus", deck: "A" }, status: 0x94, data: 0x10, type: "note" },
    { control: { kind: "focus", deck: "B" }, status: 0x95, data: 0x11, type: "note" },
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
    // Performance pads — every unshifted bank → generic position pads (see padBanks).
    ...padBanks(),
  ],
  noteStatus: { A: NOTE_A, B: NOTE_B },
  padStatus: { A: PAD_A, B: PAD_B },
  feedback: {
    play: 0x0b,
    cue: 0x0c,
    sync: 0x58,
    loop: 0x4d,
    loopIn: 0x10, // manual loop IN button lamp (same note as its input)
    loopOut: 0x11, // manual loop OUT button lamp
    hotcues: [0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07],
    // Mode-button LEDs (same notes as the inputs). Lit when our software is in that bank,
    // so changing mode by keyboard / screen / gamepad / session reflects on the board —
    // IF the unit accepts incoming note-on for these (verify with the Debug output prober).
    padModes: { cue: 0x1b, fx: 0x1e, loop: 0x20, sampler: 0x22 },
  },
  initSysex: FLX4_HANDSHAKE,
  keepAliveMs: 200,
};
