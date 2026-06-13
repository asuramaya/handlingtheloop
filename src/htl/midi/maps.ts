// Named MIDI maps: create / serialize / parse for the map manager. A map is a
// shareable bundle of learned bindings on top of an optional built-in profile.
// Stored in settings (account-synced); exported as JSON to share custom maps.

import type { MidiLearnMap, MidiMap } from "./types";
import { uid, exportEnvelope, parseEnvelope } from "../state/profiles";

const EXPORT_KIND = "htl-midi-map";
const EXPORT_VERSION = 1;

export function createMap(name: string, opts: { device?: string | null; basedOn?: string | null; bindings?: MidiLearnMap } = {}): MidiMap {
  return {
    id: uid("m"),
    name: name.trim() || "Untitled map",
    device: opts.device ?? null,
    basedOn: opts.basedOn ?? null,
    bindings: opts.bindings ? { ...opts.bindings } : {},
    updatedAt: Date.now(),
  };
}

export function duplicateMap(map: MidiMap): MidiMap {
  return { ...map, id: uid("m"), name: `${map.name} copy`, bindings: { ...map.bindings }, updatedAt: Date.now() };
}

// Pretty JSON for download / clipboard.
export function exportMap(map: MidiMap): string {
  return exportEnvelope(EXPORT_KIND, EXPORT_VERSION, "map", map);
}

// Parse a shared map (file or pasted text). Returns a FRESH-id copy so importing
// never collides with an existing one. Returns null on anything malformed.
export function parseMap(text: string): MidiMap | null {
  return parseEnvelope<MidiMap>(EXPORT_KIND, "map", text, (raw) => {
    const m = raw as Partial<MidiMap>;
    if (!m || typeof m.bindings !== "object" || m.bindings == null) return null;
    return {
      id: uid("m"),
      name: typeof m.name === "string" && m.name.trim() ? m.name : "Imported map",
      device: typeof m.device === "string" ? m.device : null,
      basedOn: typeof m.basedOn === "string" ? m.basedOn : null,
      bindings: m.bindings as MidiLearnMap,
      updatedAt: Date.now(),
    };
  });
}

export function bindingCount(map: MidiMap): number {
  return Object.keys(map.bindings).length;
}
