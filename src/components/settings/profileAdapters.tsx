// ONE PLACE THAT KNOWS WHAT "SAVE" MEANS ON EACH TAB.
//
// ★ WHY THIS FILE EXISTS. Every settings tab that had a saveable thing grew its own inline
// save/share/manage bar — Color had one, Controls had one, MIDI had one, and Audio had none at
// all because nobody had got round to it. Four tabs, three bars, and the tab that most needed a
// setup you could carry between machines was the one without. Worse, each bar ate a card's worth
// of the panel to say the same nine words.
//
// So the control moved OUT of the tabs and INTO the panel header, where there is exactly one of
// it and it is always in the same place, and this module is the switchboard: given the active
// tab, it returns that tab's adapter, or null for a tab with nothing to save (Debug, About).
// Adding a fifth family means adding a case here — not another bar.

import type { ReactNode } from "react";
import {
  type Settings,
  type ColorValue,
  snapshotColors,
  createColorProfile,
  duplicateColorProfile,
  exportColorProfile,
  parseColorProfile,
  createKeyProfile,
  duplicateKeyProfile,
  exportKeyProfile,
  parseKeyProfile,
  keyBindingCount,
  snapshotAudio,
  createAudioProfile,
  duplicateAudioProfile,
  exportAudioProfile,
  parseAudioProfile,
  audioSetupCount,
} from "@htl";
import { createMap, duplicateMap, exportMap, parseMap, bindingCount, matchProfile, type UseMidi } from "@htl/midi";
import type { ProfileBarAdapter, ProfileLike } from "../ProfileBar";

// A live gradient of the current palette, so the colour tab's control reads as "colour".
function liveSwatch(s: Settings): string {
  const cols = [s.accentA, s.accentB, s.freqLowColor, s.freqMidColor, s.freqHighColor, s.stripColor].filter(
    (v): v is string => typeof v === "string" && v.length > 0,
  );
  return cols.length ? `linear-gradient(90deg, ${cols.join(", ")})` : "var(--surface)";
}

export interface TabProfiles {
  /** What this tab's saveable thing is called, for the header label and the prompts. */
  noun: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  adapter: ProfileBarAdapter<any, any>;
  extras?: ReactNode;
}

export function profilesForTab(
  tab: string,
  settings: Settings,
  onChange: (s: Settings) => void,
  midi?: UseMidi,
): TabProfiles | null {
  const set = (patch: Partial<Settings>) => onChange({ ...settings, ...patch });

  if (tab === "color") {
    return {
      noun: "theme",
      extras: <span className="profilebar-swatch" style={{ background: liveSwatch(settings) }} />,
      adapter: {
        profiles: settings.colorProfiles ?? [],
        activeId: settings.activeColorProfileId ?? null,
        zeroLabel: "Built-in / none",
        // No overlay to clear — selecting "none" leaves the current colours untouched.
        snapshotCurrent: () => snapshotColors(settings as unknown as Record<string, ColorValue>),
        payloadOf: (p) => p.colors,
        buildNew: (name, colors) => createColorProfile(name, colors),
        duplicate: duplicateColorProfile,
        updateProfile: (p, colors) => ({ ...p, colors, updatedAt: Date.now() }),
        parseText: parseColorProfile,
        exportText: exportColorProfile,
        fileExt: "htltheme.json",
        noun: "theme",
        onCommit: ({ profiles, activeId, payload }) =>
          set({ colorProfiles: profiles, activeColorProfileId: activeId, ...(payload ? (payload as Partial<Settings>) : {}) }),
      },
    };
  }

  if (tab === "controls") {
    return {
      noun: "keys",
      adapter: {
        profiles: settings.keyProfiles ?? [],
        activeId: settings.activeKeyProfileId ?? null,
        zeroLabel: "Default keys",
        zeroPayload: () => ({}),
        snapshotCurrent: () => ({ ...settings.keyBindings }),
        payloadOf: (p) => p.bindings,
        buildNew: (name, b) => createKeyProfile(name, b),
        duplicate: duplicateKeyProfile,
        updateProfile: (p, b) => ({ ...p, bindings: b, updatedAt: Date.now() }),
        parseText: parseKeyProfile,
        exportText: exportKeyProfile,
        describe: (p) => `${keyBindingCount(p)} custom`,
        fileExt: "htlkeys.json",
        noun: "profile",
        onCommit: ({ profiles, activeId, payload }) =>
          set({ keyProfiles: profiles, activeKeyProfileId: activeId, ...(payload ? { keyBindings: payload } : {}) }),
      },
    };
  }

  if (tab === "midi" && midi) {
    const s = midi.status;
    const device = s.state === "connected" ? s.device : null;
    const matched = matchProfile(device);
    return {
      noun: "map",
      adapter: {
        profiles: settings.midiMaps,
        activeId: settings.activeMidiMapId,
        zeroLabel: matched ? `${matched.name} (built-in)` : "Built-in / none",
        zeroPayload: () => ({}),
        snapshotCurrent: () => ({ ...settings.midiBindings }),
        payloadOf: (m) => ({ ...m.bindings }),
        buildNew: (name, b) => createMap(name, { device, basedOn: matched?.id ?? null, bindings: b }),
        duplicate: duplicateMap,
        updateProfile: (m, b) => ({ ...m, bindings: b, updatedAt: Date.now() }),
        parseText: parseMap,
        exportText: exportMap,
        describe: (m) => `${bindingCount(m)} custom`,
        optionSuffix: (m) => (m.device ? ` · ${m.device}` : ""),
        fileExt: "htlmidi.json",
        noun: "map",
        onCommit: ({ profiles, activeId, payload }) =>
          set({ midiMaps: profiles, activeMidiMapId: activeId, ...(payload ? { midiBindings: payload } : {}) }),
      },
    };
  }

  if (tab === "audio") {
    return {
      noun: "setup",
      adapter: {
        profiles: settings.audioProfiles ?? [],
        activeId: settings.activeAudioProfileId ?? null,
        zeroLabel: "Current setup (unsaved)",
        // No zeroPayload: picking "none" must not silently reset someone's engine settings.
        snapshotCurrent: () => snapshotAudio(settings as unknown as Record<string, unknown>),
        payloadOf: (p) => p.setup,
        buildNew: (name, setup) => createAudioProfile(name, setup),
        duplicate: duplicateAudioProfile,
        updateProfile: (p, setup) => ({ ...p, setup, updatedAt: Date.now() }),
        parseText: parseAudioProfile,
        exportText: exportAudioProfile,
        describe: (p) => `${audioSetupCount(p)} set`,
        fileExt: "htlaudio.json",
        noun: "setup",
        onCommit: ({ profiles, activeId, payload }) =>
          set({ audioProfiles: profiles, activeAudioProfileId: activeId, ...(payload ? (payload as Partial<Settings>) : {}) }),
      },
    };
  }

  return null; // Debug / About have nothing to save.
}

export type { ProfileLike };
