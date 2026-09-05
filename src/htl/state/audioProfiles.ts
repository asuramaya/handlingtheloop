// Named AUDIO PROFILES — the fourth member of the family (colorProfiles.ts, keyProfiles.ts,
// midi/maps.ts). Audio was the one settings tab with no way to save what you had set up: you
// tuned the stretch engine and the separation quality by hand on every machine, and there was
// nothing to share when someone asked what your setup was.
//
// ★ WHAT A PROFILE MAY NOT CONTAIN: device ids. `audioOutputId`, `audioCueOutputId` and
// `audioInputId` are opaque handles minted by ONE browser on ONE machine. Carrying them across
// a sync would at best resolve to nothing and at worst silently point your master output at
// whatever device happens to hold that id here — a class of bug you would chase in the sound,
// not in the settings. So a profile is the ENGINE setup only, and the devices stay local and
// per-machine, which is also how a DJ actually thinks about them: the rig is where you are, the
// setup is what you brought.

import { uid, exportEnvelope, parseEnvelope } from "./profiles";
import type { StretchEngine, StretchQuality, StemQuality } from "./settings";

/** The syncable half of the Audio tab. Every key here is safe on any machine. */
export interface AudioSetup {
  stretchEngine: StretchEngine;
  stretchQuality: StretchQuality;
  stretchTransient: boolean;
  stretchAa: boolean;
  stretchTThresh: number;
  stemQuality: StemQuality;
  autoEnhance: boolean;
  mobileStems: boolean;
  wirelessOutput: boolean;
}

export const AUDIO_SETUP_KEYS: (keyof AudioSetup)[] = [
  "stretchEngine",
  "stretchQuality",
  "stretchTransient",
  "stretchAa",
  "stretchTThresh",
  "stemQuality",
  "autoEnhance",
  "mobileStems",
  "wirelessOutput",
];

export interface AudioProfile {
  id: string;
  name: string;
  setup: Partial<AudioSetup>;
  updatedAt: number;
}

const EXPORT_KIND = "htl-audio-profile";
const EXPORT_VERSION = 1;

/** Lift the syncable audio keys out of a Settings-shaped object. */
export function snapshotAudio(s: Record<string, unknown>): Partial<AudioSetup> {
  const out: Record<string, unknown> = {};
  for (const k of AUDIO_SETUP_KEYS) if (s[k] !== undefined) out[k] = s[k];
  return out as Partial<AudioSetup>;
}

export function createAudioProfile(name: string, setup: Partial<AudioSetup>): AudioProfile {
  return { id: uid("a"), name: name.trim() || "Untitled setup", setup: { ...setup }, updatedAt: Date.now() };
}

export function duplicateAudioProfile(p: AudioProfile): AudioProfile {
  return { ...p, id: uid("a"), name: `${p.name} copy`, setup: { ...p.setup }, updatedAt: Date.now() };
}

export function exportAudioProfile(p: AudioProfile): string {
  return exportEnvelope(EXPORT_KIND, EXPORT_VERSION, "profile", p);
}

// Parse a shared setup. Returns a FRESH-id copy and keeps ONLY the whitelisted keys — an
// import is untrusted text, and the whitelist is the same list that makes the profile
// machine-safe, so a hand-edited file cannot smuggle a device id back in through the door
// the snapshot closes.
export function parseAudioProfile(text: string): AudioProfile | null {
  return parseEnvelope<AudioProfile>(EXPORT_KIND, "profile", text, (raw) => {
    const p = raw as Partial<AudioProfile>;
    if (!p || typeof p.setup !== "object" || p.setup == null) return null;
    const src = p.setup as Record<string, unknown>;
    const setup: Record<string, unknown> = {};
    for (const k of AUDIO_SETUP_KEYS) if (src[k] !== undefined) setup[k] = src[k];
    return {
      id: uid("a"),
      name: typeof p.name === "string" && p.name.trim() ? p.name : "Imported setup",
      setup: setup as Partial<AudioSetup>,
      updatedAt: Date.now(),
    };
  });
}

/** How many of the syncable keys this profile actually pins, for the "N set" sub-label. */
export function audioSetupCount(p: AudioProfile): number {
  return AUDIO_SETUP_KEYS.filter((k) => p.setup[k] !== undefined).length;
}
