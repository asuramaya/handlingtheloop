// USB-MIDI controller support (Web MIDI API). The engine decodes raw MIDI bytes
// from a hardware DJ controller into a small, normalized control vocabulary —
// then App routes those events into the SAME action handlers + deck setters the
// keyboard and on-screen buttons already use (no parallel control system).
//
// A DeviceProfile maps a controller's raw (status, data) bytes to these controls.
// Built-in profiles (e.g. DDJ-FLX4) ship known-good maps; a generic MIDI-LEARN
// fallback lets any board be mapped by hand. Numbers for the built-ins come from
// the community Mixxx mappings + the vendor MIDI message-list PDFs.

export type DeckId = "A" | "B";

// The continuous (knob/fader) destinations. Each maps to a Deck/Engine setter in
// App's dispatcher, which scales the 0..1 value to that control's real range.
export type FaderTarget =
  | "tempo" // pitch/tempo fader → setTempo (±range %)
  | "level" // channel volume fader → setLevel (0..1)
  | "trim" // gain/trim knob → setTrim (0..2, centre = unity)
  | "eqHi" // EQ high → setEqHigh (−/+ dB)
  | "eqMid"
  | "eqLow"
  | "filter" // colour/filter knob → setFilter (−1..+1, centre = off)
  | "filterHp" // independent high-pass amount → setHpAmount (0..1)
  | "filterLp" // independent low-pass amount → setLpAmount (0..1)
  | "crossfader" // → engine.setCrossfade (−1..+1)
  | "pitch" // musical key shift → setPitch (±12 semitones)
  | "stemDrums" // per-stem level → setStemGain (0..1.5)
  | "stemBass"
  | "stemVocals"
  | "stemOther";

// What a single physical control does. `action` reuses the keyboard action ids
// from @htl keybinds (KEY_ACTIONS) so buttons share the exact same behaviour.
export type ControlSpec =
  | { kind: "action"; action: string } // button → HANDLERS[action]
  | { kind: "beatjump"; beats: number } // pad → deck.beatJump(beats)
  | { kind: "fader"; target: FaderTarget; invert?: boolean; relative?: boolean; pickup?: boolean } // knob/fader. relative = delta-track an endless encoder; pickup = absolute encoder with soft-takeover (no jump until the knob sweeps through the current value — see App)
  | { kind: "jogTurn"; scratch?: boolean } // platter rotation (relative, centred on 64). scratch:true = the dedicated SCRATCH stream (vinyl mode, FLX4 CC 0x22); scratch:false/omit = the top-plate BEND stream (non-vinyl, FLX4 CC 0x23) or a generic single-CC wheel
  | { kind: "jogBend" } // outer-ring / un-gripped rotation (relative) — momentary tempo bend
  | { kind: "jogSearch" } // SHIFT + platter rotation (relative) — fast seek/scan through the track
  | { kind: "jogTouch" } // platter top-sensor touch (note)
  | { kind: "shift" } // the SHIFT modifier button (momentary or a latching hardware toggle)
  | { kind: "encoderAction"; forward: string; backward: string } // relative encoder → fire an action per detent (step-jog like the arrow keys)
  | { kind: "focus"; deck: DeckId } // switch which deck the controller drives (pad-style boards)
  | { kind: "browse" } // browse encoder rotation (relative) — scroll the library/playlist
  | { kind: "zoom" } // encoder rotation (relative) → zoom the focused deck's waveform
  | { kind: "load" } // load-to-deck button
  | { kind: "selector" }; // browse-encoder PRESS — open/close the library + enter/exit

// One raw→control binding. `type` picks the decode: a 7-bit note, a 7-bit CC, or
// a 14-bit CC pair (MSB on `data`, LSB on `data + 0x20`).
export interface MidiBinding {
  control: ControlSpec;
  deck?: DeckId; // which deck it drives (undefined = global, e.g. crossfader/browse)
  status: number; // MIDI status byte incl. channel (0x90 = note ch1, 0xB0 = CC ch1, …)
  data: number; // note number or CC number (the MSB CC for cc14)
  type: "note" | "cc" | "cc14";
  // Dispatch the action with THIS explicit shift value, overriding the live SHIFT
  // button. true = a shifted-variant note that should run the alt action (e.g. FLX4
  // Loop-In 0x10 → 0x4C under shift); false = a button that should ignore a held SHIFT
  // (e.g. CUE/LOOP-CALL always jumps, never moves the loop). Omit = use live SHIFT.
  shift?: boolean;
}

// Output (LED / lamp) addresses, by normalized control id, so app state can light
// the controller. Velocity 0x7F = on, 0x00 = off. Hot-cue pads are an array.
export interface MidiFeedbackMap {
  play?: number; // data byte (status taken per-deck from `noteStatus`)
  cue?: number;
  sync?: number;
  loop?: number; // loop in/out lamp
  hotcues?: number[]; // pad data bytes for hot cues 1..8 (lit on the `padStatus`)
  // Pad-bank MODE buttons (FLX4: HOT CUE / PAD FX1 / BEAT JUMP / SAMPLER). One note per
  // mode, lit on `noteStatus`; the active mode lights, the rest clear. Lets the board
  // reflect a mode change made anywhere (keyboard / on-screen / gamepad / session sync).
  padModes?: Partial<Record<"cue" | "loop" | "sampler" | "fx", number>>;
}

export interface DeviceProfile {
  id: string;
  name: string; // display name
  // Substrings matched (case-insensitive) against the MIDI port name to auto-select.
  match: string[];
  bindings: MidiBinding[];
  // Per-deck status bytes for OUTPUT (LED) messages.
  noteStatus?: Record<DeckId, number>; // button LEDs (e.g. {A:0x90, B:0x91})
  padStatus?: Record<DeckId, number>; // hot-cue pad LEDs (e.g. {A:0x97, B:0x99})
  feedback?: MidiFeedbackMap;
  // SysEx sent once on connect AND repeated on `keepAliveMs` to keep some Pioneer
  // gear awake / streaming (the "rekordbox handshake"). Needs sysex permission.
  initSysex?: number[];
  keepAliveMs?: number;
}

// A decoded, normalized event handed to the app dispatcher.
export type MidiEvent =
  | { type: "button"; action: string; deck?: DeckId; pressed: boolean; shift: boolean; velocity?: number } // deck omitted = focused deck; velocity 0..127 for note pads (drives soft-preview vs hard-play)
  | { type: "shift"; deck?: DeckId; down: boolean } // the SHIFT button → drives HTL's shift mode (deck omitted = focused)
  | { type: "focus"; deck: DeckId } // a focus button → make this deck the one the controller drives
  | { type: "beatjump"; deck: DeckId; beats: number; shift: boolean }
  | { type: "fader"; target: FaderTarget; deck?: DeckId; value: number; pickup?: boolean } // value 0..1 (invert applied). pickup = apply soft-takeover in App
  | { type: "knob"; target: FaderTarget; deck?: DeckId; delta: number } // relative encoder nudge (signed fraction of full range)
  | { type: "jogTouch"; deck: DeckId; down: boolean }
  | { type: "jogTurn"; deck: DeckId; delta: number; scratch: boolean } // delta = signed ticks
  | { type: "jogBend"; deck: DeckId; delta: number } // outer-ring nudge → pitch-bend / paused search
  | { type: "jogSearch"; deck: DeckId; delta: number } // SHIFT + jog → fast seek through the track
  | { type: "browse"; delta: number }
  | { type: "zoom"; deck?: DeckId; delta: number } // encoder → zoom the focused deck's waveform
  | { type: "load"; deck: DeckId }
  | { type: "selector" }; // browse-encoder press

// Per-deck button state used to drive LED feedback.
export interface DeckFeedback {
  play: boolean;
  cue: boolean;
  sync: boolean;
  loop: boolean;
  hotcues: boolean[]; // length 8, true = slot set
  padMode: "cue" | "loop" | "sampler" | "fx"; // active pad bank → lights the matching mode button
}

// Live connection status for the settings UI.
export type MidiStatus =
  | { state: "unsupported" } // no navigator.requestMIDIAccess (Safari/iOS, insecure ctx)
  | { state: "idle" } // supported, not yet requested
  | { state: "denied"; reason?: string } // permission refused (reason = error name/message)
  | { state: "connected"; device: string | null; profile: string | null };

// A learned binding stored in settings: raw address + what it drives. Layered over
// (or instead of) a built-in profile for generic / custom controllers.
export interface LearnedBinding {
  status: number;
  data: number;
  type: "note" | "cc" | "cc14";
  control: ControlSpec;
  deck?: DeckId;
}
export type MidiLearnMap = Record<string, LearnedBinding>; // keyed by a stable control id (see learnId)

// A named, saveable, shareable mapping. Built atop an optional built-in profile
// (`basedOn`) with per-control overrides/additions in `bindings`. Stored in settings
// (so it syncs to the account) and exportable as JSON to share for custom controllers.
export interface MidiMap {
  id: string;
  name: string;
  device: string | null; // the controller port name this targets (for auto-suggest)
  basedOn: string | null; // built-in profile id it layers over (null = from scratch)
  bindings: MidiLearnMap; // the learned overrides/additions
  updatedAt: number;
}
