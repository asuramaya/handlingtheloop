// Built-in controller profiles + auto-match. Add a board by dropping a new
// DeviceProfile here — the engine matches a connected port's name against each
// profile's `match` substrings; anything unmatched falls back to MIDI-Learn.

import type { DeviceProfile } from "../types";
import { DDJ_FLX4 } from "./ddj-flx4";
import { DONNER_STARRYPAD } from "./donner-starrypad";

export const PROFILES: DeviceProfile[] = [DDJ_FLX4, DONNER_STARRYPAD];

export function matchProfile(portName: string | null | undefined): DeviceProfile | null {
  if (!portName) return null;
  const n = portName.toLowerCase();
  for (const p of PROFILES) {
    if (p.match.some((m) => n.includes(m.toLowerCase()))) return p;
  }
  return null;
}

export { DDJ_FLX4, DONNER_STARRYPAD };
