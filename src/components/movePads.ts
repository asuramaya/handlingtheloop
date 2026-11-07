import type { FxPadDef } from "./fxPads";

// ★ FX2 IS THE MOVES BANK (operator, 2026-11-06: "transition tools are cool, maybe some of the
// effects and tools that are unmapped or do not have a clear space to be at could live in fx2 …
// lets try the first draft"). FX2 used to be the same eight effects as FX, aimed at the master
// chain, so with no stem chains it was an exact duplicate ("they feel the same"). FX stays the
// chain's effects; FX2 is eight DECK MOVES:
//   SPIN · CENSOR · BRAKE, the rest still to be decided.
// Same gesture as every FX pad (fxPads): a plain press is live while held, SHIFT+press latches.
// A one-shot (SPIN) simply fires on the press.

export const MOVE_PADS: (FxPadDef | null)[] = [
  { label: "SPIN", hold: false, on: (d) => d.spinback(), hint: "Backspin — the record spun back, then playback carries on" },
  { label: "CENSOR", hold: true, on: (d) => d.censorBegin(), off: (d) => d.censorEnd(), active: (d) => d.reversing, hint: "Reverse while held; on release it lands where the track would be" },
  { label: "BRAKE", hold: true, on: (d) => d.brakeBegin(), off: (d) => d.brakeEnd(), active: (d) => d.braking, hint: "Power down while held; on release it lands where the track would be and keeps playing" },
  // 3–7: to be decided (operator, 2026-11-07: "the rest are tbd but tying them to fx doesnt really
  // work"; STUTTER already lives in ROLL). Empty slots, not placeholders.
  null,
  null,
  null,
  null,
  null,
];
