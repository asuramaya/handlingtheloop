import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, type Settings } from "@htl";
import { waveModeOf, waveModePatch } from "./ColorTab";

// Interface ▸ Waveform asks ONE question ("colour by") in place of three switches that overrode each
// other. Each answer must write a coherent set of the underlying flags and read back as itself.
describe("waveform colour mode", () => {
  it.each(["deck", "freq", "flat"] as const)("%s round-trips through the settings it writes", (m) => {
    const s = { ...DEFAULT_SETTINGS, ...waveModePatch(m) } as Settings;
    expect(waveModeOf(s)).toBe(m);
  });

  it("a half-set legacy state (bands follow the deck, lanes do not) reads as Frequency, and one click makes it coherent", () => {
    const legacy = { ...DEFAULT_SETTINGS, freqColors: true, bandFromDeck: true, stemsFollowDeck: false } as Settings;
    expect(waveModeOf(legacy)).toBe("freq");
    const fixed = { ...legacy, ...waveModePatch("deck") } as Settings;
    expect(fixed.bandFromDeck && fixed.stemsFollowDeck).toBe(true);
  });

  it("CONTROL: frequency colours off is Flat whatever the follow flags say", () => {
    expect(waveModeOf({ ...DEFAULT_SETTINGS, freqColors: false, bandFromDeck: true, stemsFollowDeck: true } as Settings)).toBe("flat");
  });
});
