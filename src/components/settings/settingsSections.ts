// Which settings each ☰ section owns: what powers the "changed from default" dot in the list and
// the per-section reset.
//
// ★ A HAND-KEPT MAP, AND THE TEST KEEPS IT HONEST. settingsSections.test.ts fails if any key of
// DEFAULT_SETTINGS belongs to no section and is not on HIDDEN, or belongs to two — so adding a
// setting without deciding where it lives is a failing build, not a silently missing dot.
import { DEFAULT_SETTINGS, type Settings } from "@htl";

export type SectionKey = "interface" | "controls" | "turntable" | "midi" | "audio" | "stems" | "lyrics";

export const SECTION_KEYS: Record<SectionKey, (keyof Settings)[]> = {
  interface: [
    "accentA", "accentB", "bgColor", "textColor", "borderColor", "selectorColor", "loopColor", "markerColor", "shiftColor", "slipMoveColor",
    "stripColor", "stemDrumsColor", "stemBassColor", "stemVocalsColor", "stemOtherColor", "freqLowColor", "freqMidColor",
    "freqHighColor", "glow", "freqColors", "freqVividness", "bandLayers", "bandFromDeck", "stemsFollowDeck", "waveformDebrick",
    "markerThickness", "playheadWidth", "gridWeight", "markerOutline", "overviewMarkerScale", "uiContrast", "inheritRoomColor", "deckArtAccent",
    "libraryDock", "settingsDock", "peopleDock", "sessionDock", "panelOrder", "panelDim",
  ],
  controls: ["wheelSeeks", "keyHints", "keyBindings", "autoPerformance", "beatlockRangePct"],
  turntable: [
    "jogWeight", "jogSensitivity", "jogBendStrength", "vinylBrakeTime", "vinylStartTime", "backSpinLength", "slip",
    "stretchEngine", "stretchQuality", "stretchTransient", "stretchAa", "stretchTThresh", "syncPhaseGain",
  ],
  midi: ["midiEnabled", "midiBindings"],
  audio: ["audioOutputId", "audioCueOutputId", "audioInputId", "wirelessOutput", "masterHeadroomDb", "perDeckLimiter"],
  stems: ["stemModel", "stemQuality", "autoEnhance", "mobileStems"],
  lyrics: ["lyricsAuto", "lyricsModel"],
};

/** Settings that no section shows: board-side controls (ranges, jump size), stores the panels
 *  manage through the profile picker (themes, key/MIDI/audio profiles, FX banks), and internal
 *  bookkeeping. Not dotted, never reset from here. */
export const HIDDEN_KEYS: (keyof Settings)[] = [
  "tempoRange", "pitchRange", "jumpBeats", "streamSource", "keyProfiles", "activeKeyProfileId", "audioProfiles",
  "activeAudioProfileId", "midiMaps", "activeMidiMapId", "colorProfiles", "fxBanks", "activeColorProfileId", "autoFx",
  "micFxSeeded",
];

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** The section's settings that differ from their defaults. */
export function changedKeys(s: Settings, section: SectionKey): (keyof Settings)[] {
  return SECTION_KEYS[section].filter((k) => !same(s[k], DEFAULT_SETTINGS[k]));
}

/** The patch that puts a section back to its defaults (only the keys that changed). */
export function resetPatch(s: Settings, section: SectionKey): Partial<Settings> {
  const out: Partial<Settings> = {};
  for (const k of changedKeys(s, section)) (out as Record<string, unknown>)[k] = structuredClone(DEFAULT_SETTINGS[k]);
  return out;
}
