import { describe, expect, it } from "vitest";
import { SC_SOURCES, sidechainSourceFor } from "./AudioEngine";

// This mapping is read by TWO places that must agree — the engine, which does the patching, and
// CompPanel, which draws the label. They read the same array precisely so they cannot drift; the
// tests below pin the thing that would break if anyone reordered it.
describe("sidechainSourceFor", () => {
  it("maps the three defined values", () => {
    expect(sidechainSourceFor(0)).toBe("off");
    expect(sidechainSourceFor(1)).toBe("deck");
    expect(sidechainSourceFor(2)).toBe("mic");
  });

  it("keeps 0 meaning OFF — the whole backward-compatibility guarantee rests on it", () => {
    // Every shipped preset carries scExt:0 and no scSrc at all. If 0 ever stopped meaning "off",
    // loading any existing preset would silently start ducking from another source.
    expect(SC_SOURCES[0]).toBe("off");
    expect(sidechainSourceFor(0)).toBe("off");
  });

  it("resolves anything unrecognised to off, not to a source", () => {
    // A param reaches this from presets, saved profiles, room sync and MIDI. An old profile has
    // no scSrc (undefined -> NaN), and a controller can send anything. Falling back to a REAL
    // source would mean a stray value silently patches the mic into someone's compressor.
    for (const v of [-1, 3, 99, NaN, Infinity, -Infinity]) {
      expect(sidechainSourceFor(v)).toBe("off");
    }
  });

  it("rounds, so a fractional value from a continuous control still lands somewhere defined", () => {
    expect(sidechainSourceFor(0.4)).toBe("off");
    expect(sidechainSourceFor(0.6)).toBe("deck");
    expect(sidechainSourceFor(1.5)).toBe("mic"); // 1.5 rounds up to 2
  });

  it("has exactly three sources — a fourth needs the panel's cycle updated too", () => {
    // CompPanel cycles with (scSrc + 1) % 3. That 3 and this length are the same fact in two
    // places; if they disagree, a source becomes unreachable from the UI with no error anywhere.
    expect(SC_SOURCES).toHaveLength(3);
  });
});
