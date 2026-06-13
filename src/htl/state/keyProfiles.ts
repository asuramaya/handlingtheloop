// Named KEYBOARD PROFILES — the missing twin of colour profiles (colorProfiles.ts) and
// MIDI maps (midi/maps.ts). A saved snapshot of the keymap overrides, stored in Settings
// (account-synced for free) and exported as JSON to share. The bindings stay SPARSE — the
// same shape as settings.keyBindings — so mergeBindings() still backfills defaults at
// dispatch and an old / partial profile still resolves every action.

import type { KeyBinding, KeyBindings } from "./keybinds";
import { uid, exportEnvelope, parseEnvelope } from "./profiles";

export interface KeyProfile {
  id: string;
  name: string;
  bindings: KeyBindings; // sparse override map (same shape as settings.keyBindings)
  updatedAt: number;
}

const EXPORT_KIND = "htl-key-profile";
const EXPORT_VERSION = 1;

export function createKeyProfile(name: string, bindings: KeyBindings): KeyProfile {
  return { id: uid("k"), name: name.trim() || "Untitled keys", bindings: { ...bindings }, updatedAt: Date.now() };
}

export function duplicateKeyProfile(p: KeyProfile): KeyProfile {
  return { ...p, id: uid("k"), name: `${p.name} copy`, bindings: { ...p.bindings }, updatedAt: Date.now() };
}

export function exportKeyProfile(p: KeyProfile): string {
  return exportEnvelope(EXPORT_KIND, EXPORT_VERSION, "profile", p);
}

// Parse a shared profile. Returns a FRESH-id copy; keeps only well-shaped {primary,secondary}
// entries (mergeBindings backfills the rest at use-time).
export function parseKeyProfile(text: string): KeyProfile | null {
  return parseEnvelope<KeyProfile>(EXPORT_KIND, "profile", text, (raw) => {
    const p = raw as Partial<KeyProfile>;
    if (!p || typeof p.bindings !== "object" || p.bindings == null) return null;
    const bindings: KeyBindings = {};
    for (const [id, b] of Object.entries(p.bindings)) {
      if (b && typeof b === "object") {
        const bb = b as Partial<KeyBinding>;
        bindings[id] = {
          primary: typeof bb.primary === "string" ? bb.primary : "",
          secondary: typeof bb.secondary === "string" ? bb.secondary : "",
        };
      }
    }
    return {
      id: uid("k"),
      name: typeof p.name === "string" && p.name.trim() ? p.name : "Imported keys",
      bindings,
      updatedAt: Date.now(),
    };
  });
}

// Count the actively-bound slots, for the ProfileBar "N custom" sub-label.
export function keyBindingCount(p: KeyProfile): number {
  return Object.values(p.bindings).filter((b) => b.primary || b.secondary).length;
}
