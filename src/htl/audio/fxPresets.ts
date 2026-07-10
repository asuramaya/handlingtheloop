// Per-effect user presets, stored client-side (localStorage), keyed by effect kind so a
// preset is shared across both decks. Minimal by design: a built-in "Default" (the device's
// reset state, not stored here) plus user-saved snapshots of the current param set. The
// menu that drives this lives in FxStrip (right-click an effect tab).

export interface FxPreset {
  name: string;
  params: Record<string, number>;
}

// FACTORY presets — built-in, read-only banks shipped in code, shown in the effect's preset menu
// ABOVE the user's own saved snapshots (which stay in localStorage) and below the device Default.
// Each `params` map is a COMPLETE param set: applyPreset only writes the listed ids, so a preset
// must fully define the device state (otherwise it inherits whatever knobs happened to be set).
// Seeded one effect at a time; the operator auditions + tweaks, then the bank is locked.
export const FACTORY_PRESETS: Record<string, FxPreset[]> = {
  // SATURATOR — the 5 style curves (TUBE/TAPE/CLIP/FOLD/DIODE) crossed with the multiband drives
  // (drive0=low <250 Hz, drive1=mid, drive2=high >2.5 kHz) so a style becomes several sounds:
  // saturate just the lows (weight, no fizz) or just the highs (air). `mix` sets how hard it hits
  // (auto gain-comp keeps it dirt-not-loudness); `bias` adds even harmonics; `punish` steepens.
  saturator: [
    { name: "Warm Bus", params: { style: 1, punish: 0, bias: 0.1, tone: 0.46, out: 0.5, drive0: 0.45, drive1: 0.4, drive2: 0.35, xover0: 0.366, xover1: 0.699, mix: 0.35 } },
    { name: "Tube Warmth", params: { style: 0, punish: 0, bias: 0.35, tone: 0.55, out: 0.5, drive0: 0.5, drive1: 0.5, drive2: 0.45, xover0: 0.366, xover1: 0.699, mix: 0.5 } },
    { name: "Tube Slam", params: { style: 0, punish: 1, bias: 0.4, tone: 0.55, out: 0.44, drive0: 0.75, drive1: 0.72, drive2: 0.6, xover0: 0.366, xover1: 0.699, mix: 0.72 } },
    { name: "Low-End Weight", params: { style: 0, punish: 1, bias: 0.2, tone: 0.5, out: 0.5, drive0: 0.85, drive1: 0.28, drive2: 0.12, xover0: 0.366, xover1: 0.699, mix: 0.6 } },
    { name: "Top Air", params: { style: 2, punish: 0, bias: 0, tone: 0.62, out: 0.48, drive0: 0.12, drive1: 0.22, drive2: 0.7, xover0: 0.366, xover1: 0.699, mix: 0.32 } },
    { name: "Transistor Fuzz", params: { style: 2, punish: 1, bias: 0.15, tone: 0.6, out: 0.4, drive0: 0.68, drive1: 0.8, drive2: 0.68, xover0: 0.366, xover1: 0.699, mix: 0.82 } },
    { name: "Metal Fold", params: { style: 3, punish: 1, bias: 0.3, tone: 0.5, out: 0.4, drive0: 0.58, drive1: 0.75, drive2: 0.64, xover0: 0.366, xover1: 0.699, mix: 0.6 } },
    { name: "Diode Honk", params: { style: 4, punish: 1, bias: 0.55, tone: 0.55, out: 0.4, drive0: 0.62, drive1: 0.8, drive2: 0.58, xover0: 0.366, xover1: 0.699, mix: 0.7 } },
  ],
  // delay / reverb / mod / crush / gate / noise / eq — seeded next, one bank at a time.
};

/** The built-in factory bank for an effect kind (read-only; [] if none seeded yet). */
export function factoryFxPresets(kind: string): FxPreset[] {
  return FACTORY_PRESETS[kind] ?? [];
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
