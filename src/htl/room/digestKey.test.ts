import { describe, expect, it } from "vitest";
import { digestKey } from "./digestKey";
import type { Intent } from "./protocol";

const fxParam = (deck: "A" | "B", slot: number, param: string, value: number, chain?: string, fx?: string): Intent =>
  ({ kind: "fxParam", deck, slot, param, value, ...(chain !== undefined ? { chain } : {}), ...(fx !== undefined ? { fx } : {}) }) as Intent;

describe("digestKey", () => {
  // THE REGRESSION. `mix` is the generic wet/dry on every FX device, so two devices in different
  // chains on one deck collided on `fxParam:A:mix` and the listener digest kept only the last.
  it("does NOT collide two FX devices sharing a param name", () => {
    const reverbOnVocals = digestKey(fxParam("A", 3, "mix", 0.4, "vocals", "reverb"));
    const delayOnMaster = digestKey(fxParam("A", 5, "mix", 0.9, "master", "delay"));
    expect(reverbOnVocals).not.toBe(delayOnMaster);
  });

  it("DOES collide the same device swept twice — that is the whole point of the digest", () => {
    const a = digestKey(fxParam("A", 3, "mix", 0.1, "vocals", "reverb"));
    const b = digestKey(fxParam("A", 3, "mix", 0.8, "vocals", "reverb"));
    expect(a).toBe(b);
  });

  it("separates the same device's different params", () => {
    expect(digestKey(fxParam("A", 3, "mix", 0.4, "vocals", "reverb"))).not.toBe(digestKey(fxParam("A", 3, "decay", 0.4, "vocals", "reverb")));
  });

  it("separates the same chain+device across decks", () => {
    expect(digestKey(fxParam("A", 3, "mix", 0.4, "vocals", "reverb"))).not.toBe(digestKey(fxParam("B", 3, "mix", 0.4, "vocals", "reverb")));
  });

  it("separates the same device kind in different chains", () => {
    expect(digestKey(fxParam("A", 1, "mix", 0.4, "vocals", "reverb"))).not.toBe(digestKey(fxParam("A", 2, "mix", 0.4, "drums", "reverb")));
  });

  // BACK-COMPAT: an older peer sends slot-only (no chain/fx). It must still coalesce per slot
  // rather than falling back to the bare param, which is the collision being fixed.
  it("falls back to the SLOT, not the param, for an address-less older peer", () => {
    expect(digestKey(fxParam("A", 3, "mix", 0.4))).not.toBe(digestKey(fxParam("A", 5, "mix", 0.9)));
    expect(digestKey(fxParam("A", 3, "mix", 0.4))).toBe(digestKey(fxParam("A", 3, "mix", 0.7)));
  });

  it("keys fxBypass on the same address as fxParam, and apart from it", () => {
    const p = digestKey({ kind: "fxParam", deck: "A", slot: 3, param: "mix", value: 0.4, chain: "vocals", fx: "reverb" } as Intent);
    const b = digestKey({ kind: "fxBypass", deck: "A", slot: 3, value: true, chain: "vocals", fx: "reverb" } as Intent);
    expect(p).not.toBe(b);
  });

  // The non-FX kinds keep their existing behaviour exactly — this fix must not widen past FX.
  it("leaves control/crossfade/stemGain keying unchanged", () => {
    expect(digestKey({ kind: "control", deck: "A", param: "tempo", value: 1 } as Intent)).toBe("control:A:tempo");
    expect(digestKey({ kind: "stemGain", deck: "B", stem: "vocals", value: 0.5 } as unknown as Intent)).toBe("stemGain:B:vocals");
    expect(digestKey({ kind: "crossfade", value: 0.5 } as Intent)).toBe("crossfade::");
  });
});
