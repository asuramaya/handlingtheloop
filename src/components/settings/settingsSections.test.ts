import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, type Settings } from "@htl";
import { HIDDEN_KEYS, SECTION_KEYS, changedKeys, resetPatch } from "./settingsSections";

describe("settings sections", () => {
  it("every setting lives in exactly one section or is explicitly hidden (a new setting must be placed)", () => {
    const owners = new Map<string, string[]>();
    for (const [sec, keys] of Object.entries(SECTION_KEYS)) for (const k of keys) owners.set(k, [...(owners.get(k) ?? []), sec]);
    for (const k of HIDDEN_KEYS) owners.set(k, [...(owners.get(k) ?? []), "hidden"]);
    const unplaced = Object.keys(DEFAULT_SETTINGS).filter((k) => !owners.has(k));
    const doubled = [...owners].filter(([, v]) => v.length > 1).map(([k, v]) => `${k}: ${v.join("+")}`);
    expect(unplaced).toEqual([]);
    expect(doubled).toEqual([]);
  });

  it("defaults have nothing changed; one moved knob is exactly one change, and reset undoes only it", () => {
    expect(changedKeys(DEFAULT_SETTINGS, "turntable")).toEqual([]);
    const s = { ...DEFAULT_SETTINGS, jogWeight: 0.9, glow: !DEFAULT_SETTINGS.glow } as Settings;
    expect(changedKeys(s, "turntable")).toEqual(["jogWeight"]);
    expect(resetPatch(s, "turntable")).toEqual({ jogWeight: DEFAULT_SETTINGS.jogWeight });
    expect(changedKeys(s, "interface")).toEqual(["glow"]);
  });
});
