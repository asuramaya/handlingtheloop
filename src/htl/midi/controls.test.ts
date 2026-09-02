import { describe, expect, it } from "vitest";
import { LEARN_CONTROLS } from "./controls";
import { SAMPLER_GLOBAL_COUNT, SAMPLER_PAD_COUNT, SAMPLER_REGION_COUNT, samplerRouteOf } from "../audio/Sampler";

// The MIDI learn list names sampler pads by BANK ("Deck A pad 3") but binds them by the
// sampler's FLAT index, and the two live in different modules that cannot import each other.
// When they drifted (a 12-global learn list against an 8-global sampler) every learned pad past
// the 8th fired the wrong one, silently — a mapping bug no type checked. So: check it here.
describe("MIDI learn ↔ sampler pad layout", () => {
  it("lists exactly one learnable control per real pad", () => {
    const pads = LEARN_CONTROLS.filter((c) => /^sampler\d+$/.test(c.id));
    expect(pads).toHaveLength(SAMPLER_PAD_COUNT);
    expect(pads.map((c) => c.id)).toEqual(Array.from({ length: SAMPLER_PAD_COUNT }, (_, i) => `sampler${i}`));
  });

  it("labels every pad with the bank the sampler actually routes it to", () => {
    const bank = { A: "Deck A", master: "Global", B: "Deck B" } as const;
    for (const c of LEARN_CONTROLS) {
      const m = /^sampler(\d+)$/.exec(c.id);
      if (!m) continue;
      expect(c.label.startsWith(bank[samplerRouteOf(Number(m[1]))])).toBe(true);
    }
  });

  it("numbers each bank from 1", () => {
    const labels = LEARN_CONTROLS.filter((c) => /^sampler\d+$/.test(c.id)).map((c) => c.label);
    expect(labels[0]).toBe("Global pad 1");
    expect(labels[SAMPLER_GLOBAL_COUNT]).toBe("Deck A pad 1");
    expect(labels[SAMPLER_GLOBAL_COUNT + SAMPLER_REGION_COUNT]).toBe("Deck B pad 1");
    expect(labels[SAMPLER_PAD_COUNT - 1]).toBe(`Deck B pad ${SAMPLER_REGION_COUNT}`);
  });
});
