// Named MIDI maps: create / serialize / parse for the map manager. A map is a
// shareable bundle of learned bindings on top of an optional built-in profile.
// Stored in settings (account-synced); exported as JSON to share custom maps.

import type { MidiLearnMap, MidiMap } from "./types";

const EXPORT_KIND = "htl-midi-map";
const EXPORT_VERSION = 1;

function uid(): string {
  try {
    const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
    if (c?.randomUUID) return c.randomUUID();
  } catch {
    /* fall through */
  }
  return `m_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
}

export function createMap(name: string, opts: { device?: string | null; basedOn?: string | null; bindings?: MidiLearnMap } = {}): MidiMap {
  return {
    id: uid(),
    name: name.trim() || "Untitled map",
    device: opts.device ?? null,
    basedOn: opts.basedOn ?? null,
    bindings: opts.bindings ? { ...opts.bindings } : {},
    updatedAt: Date.now(),
  };
}

export function duplicateMap(map: MidiMap): MidiMap {
  return { ...map, id: uid(), name: `${map.name} copy`, bindings: { ...map.bindings }, updatedAt: Date.now() };
}

// Pretty JSON for download / clipboard.
export function exportMap(map: MidiMap): string {
  return JSON.stringify({ kind: EXPORT_KIND, version: EXPORT_VERSION, map }, null, 2);
}

// Parse a shared map (file or pasted text). Returns a FRESH-id copy so importing
// never collides with an existing one. Returns null on anything malformed.
export function parseMap(text: string): MidiMap | null {
  try {
    const o = JSON.parse(text) as { kind?: string; map?: Partial<MidiMap> };
    const m = o?.kind === EXPORT_KIND && o.map ? o.map : (o as unknown as Partial<MidiMap>);
    if (!m || typeof m.bindings !== "object" || m.bindings == null) return null;
    return {
      id: uid(),
      name: typeof m.name === "string" && m.name.trim() ? m.name : "Imported map",
      device: typeof m.device === "string" ? m.device : null,
      basedOn: typeof m.basedOn === "string" ? m.basedOn : null,
      bindings: m.bindings as MidiLearnMap,
      updatedAt: Date.now(),
    };
  } catch {
    return null;
  }
}

export function bindingCount(map: MidiMap): number {
  return Object.keys(map.bindings).length;
}
