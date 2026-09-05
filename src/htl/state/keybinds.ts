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
  // ★ THE MIC HAD NO KEY, and that is exactly why its button had to live permanently on the board:
  // with no binding, an on-screen control was the only way in on every surface, so the whole input
  // section was pinned there for everyone. Backquote is the classic push-to-talk key, it is global
  // rather than deck-scoped, and it sits far from the transport row so a fumble cannot hit it.
  { id: "micToggle", label: "Microphone talkover on / off", group: "Global", defaultKey: "Backquote" },

  { id: "play", label: "Play / pause", group: "Transport", defaultKey: "Space", shiftLabel: "Reset channel" },
  { id: "cue", label: "Cue", group: "Transport", defaultKey: "KeyC", shiftLabel: "Jump to start" },

  { id: "sync", label: "Beat sync", group: "Mix", defaultKey: "KeyS", shiftLabel: "Reset tempo" },
  { id: "keyMatch", label: "Key match", group: "Mix", defaultKey: "KeyA", shiftLabel: "Reset pitch" },
  // Z sits physically right under A/S — a dedicated key for key-lock rather than a ⇧F combo,
  // which read as confusing (F already means something plain-pressed; overloading its shift
  // for a persistent toggle wasn't obvious). Own key, own on-screen button (DeckControls).
  { id: "keylock", label: "Key lock (couple/decouple tempo & pitch)", group: "Mix", defaultKey: "KeyZ" },
  { id: "tempoRange", label: "Cycle tempo range", group: "Mix", defaultKey: "KeyF" },
  { id: "pitchRange", label: "Cycle pitch range", group: "Mix", defaultKey: "KeyD" },
  { id: "matchGain", label: "Match gain (dB)", group: "Mix", defaultKey: "KeyR" },
  { id: "grid", label: "Grid magnet (snap)", group: "Mix", defaultKey: "KeyG", shiftLabel: "Step skip size" },
  { id: "smartFader", label: "Smart Fader (auto-transition)", group: "Mix", defaultKey: "KeyT", shiftLabel: "Enable / disable crossfader" },

  { id: "pitchDown", label: "Key down a semitone", group: "Pitch", defaultKey: "Minus", shiftLabel: "Nudge tempo down" },
  { id: "pitchUp", label: "Key up a semitone", group: "Pitch", defaultKey: "Equal", shiftLabel: "Nudge tempo up" },

  { id: "loopIn", label: "Loop In", group: "Loops", defaultKey: "KeyQ", shiftLabel: "Adjust loop-in (drag / scroll / arrows)" },
  { id: "loopOut", label: "Loop Out", group: "Loops", defaultKey: "KeyW", shiftLabel: "Adjust loop-out (drag / scroll / arrows)" },
  { id: "loopExit", label: "Loop Exit / Reloop", group: "Loops", defaultKey: "KeyE", shiftLabel: "Clear loop" },

  // Pad-mode selectors: switch what the 8 pads (and the keyboard 1-8) do. U=cue, I=loop.
  // U·I·O·P read left-to-right across the on-screen mode row, which is ordered to mirror
  // the FLX4's physical bank buttons: CUE · FX · LOOP · SMP (HOT CUE / PAD FX1 / BEAT JUMP / SAMPLER).
  // ★ Chain switching. With chains, the pad bank is AIMED by the chain you have selected — so a
  // keyboard/controller player who cannot change that selection cannot re-aim their pads at all.
  // "<" and ">" walk the chain row; the pads and the panel follow.
  { id: "chainPrev", label: "Previous FX chain", group: "Pads", defaultKey: "Comma" },
  { id: "chainNext", label: "Next FX chain", group: "Pads", defaultKey: "Period" },
  { id: "padModeCue", label: "Pad mode: Hot Cue", group: "Pads", defaultKey: "KeyU" },
  { id: "padModeFx", label: "Pad mode: FX", group: "Pads", defaultKey: "KeyI", shiftLabel: "Pad mode: FX2 (latch)" },
  { id: "padModeLoop", label: "Pad mode: Loop", group: "Pads", defaultKey: "KeyO", shiftLabel: "Pad mode: Roll" },
  { id: "padModeSampler", label: "Pad mode: Sampler (local)", group: "Pads", defaultKey: "KeyP", shiftLabel: "Pad mode: Global" },
  // The 8 beat-loop sizes still exist as actions (MIDI / rebindable), but their dedicated
  // keys are FREED — 1-8 now fire them when the pad bank is in Loop mode.
  { id: "beatLoop0", label: "Beat loop 1/16", group: "Pads", defaultKey: "" },
  { id: "beatLoop1", label: "Beat loop 1/8", group: "Pads", defaultKey: "" },
  { id: "beatLoop2", label: "Beat loop 1/4", group: "Pads", defaultKey: "" },
  { id: "beatLoop3", label: "Beat loop 1/2", group: "Pads", defaultKey: "" },
  { id: "beatLoop4", label: "Beat loop 1", group: "Pads", defaultKey: "" },
  { id: "beatLoop5", label: "Beat loop 2", group: "Pads", defaultKey: "" },
  { id: "beatLoop6", label: "Beat loop 4", group: "Pads", defaultKey: "" },
  { id: "beatLoop7", label: "Beat loop 8", group: "Pads", defaultKey: "" },

  { id: "muteDrums", label: "Mute Drums", group: "Stems", defaultKey: "KeyV", shiftLabel: "Solo Drums" },
  { id: "muteBass", label: "Mute Bass", group: "Stems", defaultKey: "KeyB", shiftLabel: "Solo Bass" },
  { id: "muteVocals", label: "Mute Vocals", group: "Stems", defaultKey: "KeyN", shiftLabel: "Solo Vocals" },
  { id: "muteInst", label: "Mute Inst", group: "Stems", defaultKey: "KeyM", shiftLabel: "Solo Inst" },

  { id: "jogBackBeat", label: "Nudge back a beat", group: "Jog", defaultKey: "ArrowLeft", shiftLabel: "Move loop back" },
  { id: "jogFwdBeat", label: "Nudge forward a beat", group: "Jog", defaultKey: "ArrowRight", shiftLabel: "Move loop forward" },
  { id: "jogBack", label: "Jump back (skip size)", group: "Jog", defaultKey: "ArrowDown", shiftLabel: "Move loop back" },
  { id: "jogFwd", label: "Jump forward (skip size)", group: "Jog", defaultKey: "ArrowUp", shiftLabel: "Move loop forward" },
  { id: "phraseBack", label: "Jump back a phrase", group: "Jog", defaultKey: "BracketLeft" },
  { id: "phraseFwd", label: "Jump forward a phrase", group: "Jog", defaultKey: "BracketRight" },
  // The Release-FX / toggle cluster, consolidated onto one contiguous home-row block (was
  // scattered across X/Z/R): H·J are the two Release-FX one-shot triggers (motor-driven,
  // independent of the physical jog — see JogEngine's spinback()/releaseBrake() doc comments),
  // K·L are the two hold/toggle jog modifiers. R/X/Z are left free (not reassigned).
  { id: "spinback", label: "Spinback (back-spin)", group: "Jog", defaultKey: "KeyH", shiftLabel: "Stronger / longer spin" },
  { id: "releaseBrake", label: "Release Brake (Vinyl Break)", group: "Jog", defaultKey: "KeyJ" },
  { id: "slip", label: "Slip mode (toggle)", group: "Jog", defaultKey: "KeyK" },
  // No key-up on the keyboard, so CENSOR toggles: press to run backward, press again to
  // slip-snap forward.
  { id: "censor", label: "Censor (reverse — press again to return)", group: "Jog", defaultKey: "KeyL", shiftLabel: "Sustained reverse" },

  // The 8 pads (1-8): act as hot cues / beat loops / sampler per the deck's pad mode.
  ...Array.from({ length: 8 }, (_, i) => ({
    id: `hotcue${i + 1}`,
    // The label cannot name one behaviour: the pad row follows the deck's PAD MODE, and it
    // has four (Hot Cue / FX / Loop / Sampler), not the two this used to claim.
    label: `Pad ${i + 1} (by pad mode)`,
    group: "Pads",
    defaultKey: `Digit${i + 1}`,
    shiftLabel: "Save loop / clear (cue mode)",
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

// code → actionId lookup for the keydown dispatcher (primary + secondary both map). On a
// collision the LAST writer (later in KEY_ACTIONS) wins — deterministic, but it orphans the
// earlier action, so the Keys editor surfaces conflicts (bindingConflicts) rather than letting
// a key silently drive the wrong action. The editor steals a code on edit, but a partial saved
// map can still collide with a newly-shipped DEFAULT (version drift), so this stays defensive.
export function bindingIndex(bindings: KeyBindings): Map<string, string> {
  const m = new Map<string, string>();
  for (const a of KEY_ACTIONS) {
    const b = bindings[a.id];
    if (b?.primary) m.set(b.primary, a.id);
    if (b?.secondary) m.set(b.secondary, a.id);
  }
  return m;
}

// Codes bound to MORE THAN ONE action → the set the Keys editor warns about. A single action
// reusing the same code for its own primary + secondary is NOT a conflict (it drives one action).
// Empty map = clean. Keyed by code → the distinct action ids that claim it (in KEY_ACTIONS order).
export function bindingConflicts(bindings: KeyBindings): Map<string, string[]> {
  const byCode = new Map<string, string[]>();
  for (const a of KEY_ACTIONS) {
    const b = bindings[a.id];
    for (const code of [b?.primary, b?.secondary]) {
      if (!code) continue;
      const ids = byCode.get(code) ?? [];
      if (!ids.includes(a.id)) ids.push(a.id);
      byCode.set(code, ids);
    }
  }
  const out = new Map<string, string[]>();
  for (const [code, ids] of byCode) if (ids.length > 1) out.set(code, ids);
  return out;
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
