import type { FxPadDef } from "./fxPads";

// ★ FX2 IS THE MOVES BANK (operator, 2026-11-06: "transition tools are cool, maybe some of the
// effects and tools that are unmapped or do not have a clear space to be at could live in fx2 …
// lets try the first draft"). FX2 used to be the same eight effects as FX, aimed at the master
// chain, so with no stem chains it was an exact duplicate ("they feel the same"). FX stays the
// chain's effects; FX2 is eight DECK MOVES:
//   SPIN · CENSOR · BRAKE · CUT, the bottom row still to be decided.
// Same gesture as every FX pad (fxPads): a plain press is live while held, SHIFT+press latches.
// SPIN, CENSOR and BRAKE are SLIP overlays: the track keeps going underneath and the release lands
// on it. CUT just silences it.

export const MOVE_PADS: (FxPadDef | null)[] = [
  // SPIN: plain = the held slip spin (lands on the beat); SHIFT = a REAL backspin — the record goes
  // back and plays on from there (operator, 2026-11-07: "let spin actually go back in the playhead
  // when shift spin and normal when no shift"), with no slip layer, because nothing continues.
  { label: "SPIN", hold: true, on: (d) => d.spinBegin(), off: (d) => d.spinEnd(), active: (d) => d.spinning, shiftOn: (d) => d.spinback(), hint: "Backspin while held, landing on the beat · SHIFT = a real backspin that goes back and plays on" },
  { label: "CENSOR", hold: true, on: (d) => d.censorBegin(), off: (d) => d.censorEnd(), active: (d) => d.reversing, hint: "Reverse while held; on release it lands where the track would be" },
  { label: "BRAKE", hold: true, on: (d) => d.brakeBegin(), off: (d) => d.brakeEnd(), active: (d) => d.braking, hint: "Power down while held; on release it lands where the track would be and keeps playing" },
  // CUT (operator, 2026-11-07: "lets do cut for #4"): the deck drops out while held and slams back
  // in where the track has got to — it never stopped, it was only silent.
  { label: "CUT", hold: true, on: (d) => d.setCut(true), off: (d) => d.setCut(false), active: (d) => d.cutting, hint: "Silence the deck while held; it drops back in where the track has got to" },
  // 4–7: still being decided (operator: "need to keep brainstorming the rest"). Empty, not placeholders.
  null,
  null,
  null,
  null,
];
