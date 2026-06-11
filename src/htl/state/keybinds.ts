// Programmable keyboard map. Each ACTION drives the focused deck and has two key
// bindings — a primary and a secondary (blank by default) — that BOTH trigger it.
// Bindings are stored as physical key codes (KeyboardEvent.code) so they're layout-
// and modifier-independent. The live SHIFT modifier (held key or the on-screen
// latch) selects each action's shifted variant, shown as `shiftLabel`.

export type KeyBinding = { primary: string; secondary: string }; // "" = unset
export type KeyBindings = Record<string, KeyBinding>;

export interface KeyAction {
  id: string;
  label: string; // base action
  group: string; // section header in the Keys settings tab
  defaultKey: string; // default primary code
  shiftLabel?: string; // what ⇧ + this key does (for the hint; not separately bindable)
}

// The full action set, in display order. Defaults reproduce the classic DDJ-style
// map. `focusToggle` is the only non-deck action (Tab switches the focused deck).
export const KEY_ACTIONS: KeyAction[] = [
  { id: "focusToggle", label: "Switch focused deck (A ↔ B)", group: "Global", defaultKey: "Tab" },

  { id: "play", label: "Play / pause", group: "Transport", defaultKey: "Space", shiftLabel: "Play from cue" },
  { id: "cue", label: "Cue", group: "Transport", defaultKey: "KeyC", shiftLabel: "Jump to start" },

  { id: "sync", label: "Beat sync", group: "Mix", defaultKey: "KeyA", shiftLabel: "Reset pitch" },
  { id: "keyMatch", label: "Key match", group: "Mix", defaultKey: "KeyS", shiftLabel: "Reset channel" },
  { id: "fx", label: "FX (filter) on / off", group: "Mix", defaultKey: "KeyD" },
  { id: "tempoRange", label: "Cycle tempo range", group: "Mix", defaultKey: "KeyF", shiftLabel: "Match gain (dB)" },
  { id: "grid", label: "Grid magnet (snap)", group: "Mix", defaultKey: "KeyG", shiftLabel: "Step skip size" },

  { id: "pitchDown", label: "Key down a semitone", group: "Pitch", defaultKey: "Minus", shiftLabel: "Nudge tempo down" },
  { id: "pitchUp", label: "Key up a semitone", group: "Pitch", defaultKey: "Equal", shiftLabel: "Nudge tempo up" },

  { id: "loopIn", label: "Loop In", group: "Loops", defaultKey: "KeyQ" },
  { id: "loopOut", label: "Loop Out", group: "Loops", defaultKey: "KeyW" },
  { id: "loopExit", label: "Loop Exit / Reloop", group: "Loops", defaultKey: "KeyE" },
  { id: "beatLoop0", label: "Beat loop 1/2", group: "Loops", defaultKey: "KeyU", shiftLabel: "1 beat" },
  { id: "beatLoop1", label: "Beat loop 1/4", group: "Loops", defaultKey: "KeyI", shiftLabel: "2 beats" },
  { id: "beatLoop2", label: "Beat loop 1/8", group: "Loops", defaultKey: "KeyO", shiftLabel: "4 beats" },
  { id: "beatLoop3", label: "Beat loop 1/16", group: "Loops", defaultKey: "KeyP", shiftLabel: "8 beats" },

  { id: "muteDrums", label: "Mute Drums", group: "Stems", defaultKey: "KeyH" },
  { id: "muteBass", label: "Mute Bass", group: "Stems", defaultKey: "KeyJ" },
  { id: "muteVocals", label: "Mute Vocals", group: "Stems", defaultKey: "KeyK" },
  { id: "muteInst", label: "Mute Inst", group: "Stems", defaultKey: "KeyL" },

  { id: "jogBackBeat", label: "Nudge back a beat", group: "Jog", defaultKey: "ArrowLeft", shiftLabel: "Move loop back" },
  { id: "jogFwdBeat", label: "Nudge forward a beat", group: "Jog", defaultKey: "ArrowRight", shiftLabel: "Move loop forward" },
  { id: "jogBack", label: "Jump back (skip size)", group: "Jog", defaultKey: "ArrowDown", shiftLabel: "Move loop back" },
  { id: "jogFwd", label: "Jump forward (skip size)", group: "Jog", defaultKey: "ArrowUp", shiftLabel: "Move loop forward" },

  ...Array.from({ length: 8 }, (_, i) => ({
    id: `hotcue${i + 1}`,
    label: `Hot cue ${i + 1}`,
    group: "Hot cues",
    defaultKey: `Digit${i + 1}`,
    shiftLabel: "Save loop / clear",
  })),
];

export const DEFAULT_BINDINGS: KeyBindings = Object.fromEntries(
  KEY_ACTIONS.map((a) => [a.id, { primary: a.defaultKey, secondary: "" }]),
);

// User bindings (from settings) layered over the defaults, so a partial/older saved
// map still resolves every action.
export function mergeBindings(saved: KeyBindings | undefined): KeyBindings {
  const out: KeyBindings = {};
  for (const a of KEY_ACTIONS) out[a.id] = { ...DEFAULT_BINDINGS[a.id], ...(saved?.[a.id] ?? {}) };
  return out;
}

// code → actionId lookup for the keydown dispatcher (primary + secondary both map).
export function bindingIndex(bindings: KeyBindings): Map<string, string> {
  const m = new Map<string, string>();
  for (const a of KEY_ACTIONS) {
    const b = bindings[a.id];
    if (b?.primary) m.set(b.primary, a.id);
    if (b?.secondary) m.set(b.secondary, a.id);
  }
  return m;
}

// Human label for a key code shown on the binding chips.
const SPECIAL: Record<string, string> = {
  Space: "Space",
  Tab: "Tab",
  Enter: "Enter",
  Escape: "Esc",
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
  Minus: "−",
  Equal: "+",
  NumpadSubtract: "Num −",
  NumpadAdd: "Num +",
  Backquote: "`",
  BracketLeft: "[",
  BracketRight: "]",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backslash: "\\",
};
export function codeLabel(code: string): string {
  if (!code) return "";
  if (SPECIAL[code]) return SPECIAL[code];
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1];
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit) return digit[1];
  const numpad = /^Numpad([0-9])$/.exec(code);
  if (numpad) return `Num ${numpad[1]}`;
  return code;
}
