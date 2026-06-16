// Per-effect user presets, stored client-side (localStorage), keyed by effect kind so a
// preset is shared across both decks. Minimal by design: a built-in "Default" (the device's
// reset state, not stored here) plus user-saved snapshots of the current param set. The
// menu that drives this lives in FxStrip (right-click an effect tab).

export interface FxPreset {
  name: string;
  params: Record<string, number>;
}

const KEY = (kind: string) => `htl:fxpreset:${kind}`;

export function loadFxPresets(kind: string): FxPreset[] {
  try {
    const raw = localStorage.getItem(KEY(kind));
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((p) => p && typeof p.name === "string" && p.params && typeof p.params === "object") : [];
  } catch {
    return [];
  }
}

export function saveFxPreset(kind: string, name: string, params: Record<string, number>): FxPreset[] {
  const clean = name.trim();
  if (!clean) return loadFxPresets(kind);
  const list = loadFxPresets(kind).filter((p) => p.name !== clean); // overwrite a same-name preset
  list.push({ name: clean, params });
  try {
    localStorage.setItem(KEY(kind), JSON.stringify(list));
  } catch {
    /* quota / unavailable — the preset just won't persist this session */
  }
  return list;
}

export function renameFxPreset(kind: string, oldName: string, newName: string): FxPreset[] {
  const clean = newName.trim();
  const list = loadFxPresets(kind);
  const found = list.find((p) => p.name === oldName);
  if (!clean || !found) return list;
  const next = list.filter((p) => p.name !== oldName && p.name !== clean);
  next.push({ name: clean, params: found.params });
  try {
    localStorage.setItem(KEY(kind), JSON.stringify(next));
  } catch {
    /* ignore */
  }
  return next;
}

export function deleteFxPreset(kind: string, name: string): FxPreset[] {
  const list = loadFxPresets(kind).filter((p) => p.name !== name);
  try {
    localStorage.setItem(KEY(kind), JSON.stringify(list));
  } catch {
    /* ignore */
  }
  return list;
}
