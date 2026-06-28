import { describe, it, expect } from "vitest";
import {
  COLOR_PROFILE_KEYS,
  snapshotColors,
  createColorProfile,
  duplicateColorProfile,
  exportColorProfile,
  parseColorProfile,
  type ColorSnapshot,
} from "./colorProfiles";

// A snapshot exercising every COLOR_PROFILE_KEYS field with a value of a legal type
// (string | number | boolean). freqColors is technically meant to be a structured
// value but the codec only keeps string|number|boolean, so we use a string here.
const fullColors: ColorSnapshot = {
  accentA: "#ff0000",
  accentB: "#00ff00",
  bgColor: "#111111",
  textColor: "#eeeeee",
  borderColor: "#333333",
  selectorColor: "#abcdef",
  loopColor: "#ffcc00",
  markerColor: "#cc00ff",
  shiftColor: "#00ccff",
  stripColor: "#444444",
  stemDrumsColor: "#aa0000",
  stemBassColor: "#00aa00",
  stemVocalsColor: "#0000aa",
  stemOtherColor: "#aaaa00",
  freqLowColor: "#100000",
  freqMidColor: "#001000",
  freqHighColor: "#000010",
  freqColors: "true",
  freqVividness: 0.75,
  glow: true,
};

describe("snapshotColors", () => {
  it("picks only COLOR_PROFILE_KEYS from a settings-like object, dropping foreign keys", () => {
    const snap = snapshotColors({ ...fullColors, notAColorKey: "junk", anotherJunk: 5 } as ColorSnapshot);
    expect(Object.keys(snap).sort()).toEqual([...COLOR_PROFILE_KEYS].sort());
    expect("notAColorKey" in snap).toBe(false);
  });

  it("skips keys whose value is undefined", () => {
    const snap = snapshotColors({ accentA: "#fff", bgColor: undefined as unknown as string });
    expect(snap.accentA).toBe("#fff");
    expect("bgColor" in snap).toBe(false);
  });
});

describe("createColorProfile", () => {
  it("assigns an id, trims the name, clones colors, stamps updatedAt", () => {
    const p = createColorProfile("  My Theme  ", fullColors);
    expect(p.id).toBeTruthy();
    expect(p.name).toBe("My Theme");
    expect(p.colors).toEqual(fullColors);
    expect(p.colors).not.toBe(fullColors); // cloned
    expect(typeof p.updatedAt).toBe("number");
  });

  it("falls back to 'Untitled theme' for an empty/blank name", () => {
    expect(createColorProfile("   ", fullColors).name).toBe("Untitled theme");
  });
});

describe("duplicateColorProfile", () => {
  it("gives a fresh id and a ' copy' name, preserving colors", () => {
    const orig = createColorProfile("Sunset", fullColors);
    const dup = duplicateColorProfile(orig);
    expect(dup.id).not.toBe(orig.id);
    expect(dup.name).toBe("Sunset copy");
    expect(dup.colors).toEqual(orig.colors);
    expect(dup.colors).not.toBe(orig.colors); // cloned
  });
});

describe("exportColorProfile / parseColorProfile round-trip", () => {
  it("preserves every COLOR_PROFILE_KEYS field and the name through export→import", () => {
    const orig = createColorProfile("RoundTrip", fullColors);
    const parsed = parseColorProfile(exportColorProfile(orig));
    expect(parsed).not.toBeNull();
    expect(parsed!.name).toBe("RoundTrip");
    // every field survives
    for (const k of COLOR_PROFILE_KEYS) {
      expect(parsed!.colors[k]).toEqual(fullColors[k]);
    }
    expect(Object.keys(parsed!.colors).sort()).toEqual([...COLOR_PROFILE_KEYS].sort());
  });

  it("assigns a FRESH id on import (do not assert id equality)", () => {
    const orig = createColorProfile("X", fullColors);
    const parsed = parseColorProfile(exportColorProfile(orig));
    expect(parsed!.id).not.toBe(orig.id);
    expect(parsed!.id).toBeTruthy();
  });

  it("drops unknown extra colour keys on import (silent-data-loss whitelist path)", () => {
    const profile = createColorProfile("Y", { accentA: "#fff", evilKey: "haxx" } as ColorSnapshot);
    const parsed = parseColorProfile(exportColorProfile(profile));
    expect(parsed!.colors.accentA).toBe("#fff"); // legit field survives
    expect("evilKey" in parsed!.colors).toBe(false); // junk dropped
  });

  it("drops a whitelisted key whose VALUE is a non-primitive (e.g. object/array)", () => {
    const profile = createColorProfile("Z", { accentA: "#fff", glow: { nested: true } } as unknown as ColorSnapshot);
    const parsed = parseColorProfile(exportColorProfile(profile));
    expect(parsed!.colors.accentA).toBe("#fff");
    expect("glow" in parsed!.colors).toBe(false); // malformed value dropped
  });

  it("mismatched kind → null", () => {
    // The colour payload requires p.colors to be an object; a wrong-kind envelope
    // makes sanitize see the OUTER {kind, version, profile} object, which has no
    // `.colors`, so it returns null.
    const text = JSON.stringify({ kind: "htl-not-color", version: 1, profile: createColorProfile("A", fullColors) });
    expect(parseColorProfile(text)).toBeNull();
  });

  it("bare-payload backcompat: a raw profile object (no envelope) imports", () => {
    const bare = JSON.stringify(createColorProfile("Bare", fullColors));
    const parsed = parseColorProfile(bare);
    expect(parsed).not.toBeNull();
    expect(parsed!.colors.accentA).toBe(fullColors.accentA);
  });

  it("garbage string → null (not a throw)", () => {
    expect(parseColorProfile("not json at all")).toBeNull();
    expect(parseColorProfile("")).toBeNull();
  });

  it("missing/empty colors object → null", () => {
    expect(parseColorProfile(JSON.stringify({ name: "n", colors: null }))).toBeNull();
    // all-foreign colors leaves an empty snapshot → null
    expect(parseColorProfile(JSON.stringify({ name: "n", colors: { junk: 1 } }))).toBeNull();
  });

  it("missing name on import falls back to 'Imported theme'", () => {
    const parsed = parseColorProfile(JSON.stringify({ colors: { accentA: "#fff" } }));
    expect(parsed!.name).toBe("Imported theme");
  });
});
