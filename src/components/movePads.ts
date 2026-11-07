import type { MoveKind } from "@htl/audio";
import type { FxPadDef } from "./fxPads";

// ★ FX2 IS THE MOVES BANK (operator, 2026-11-06: "transition tools are cool, maybe some of the
// effects and tools that are unmapped or do not have a clear space to be at could live in fx2 …
// lets try the first draft"). FX2 used to be the same eight effects as FX, aimed at the master
// chain, so with no stem chains it was an exact duplicate ("they feel the same"). FX stays the
// chain's effects; FX2 is eight DECK MOVES:
//   SPIN · CENSOR · BRAKE · CUT / — · FREEZE · — · —
// Same gesture as every FX pad (fxPads): a plain press is live while held, SHIFT+press latches.
// SPIN, CENSOR and BRAKE are SLIP overlays: the track keeps going underneath and the release lands
// on it. CUT just silences it.

// Every move but CUT runs on the deck's move stack (Deck.moveDown / moveUp): last pressed wins,
// releasing falls back to a move still held, releasing the last lands on the beat.
const move = (label: string, k: MoveKind, hint: string, extra: Partial<FxPadDef> = {}): FxPadDef => ({
  label,
  hold: true,
  on: (d) => d.moveDown(k),
  off: (d) => d.moveUp(k),
  active: (d) => d.moveHeld(k),
  hint,
  ...extra,
});

export const MOVE_PADS: (FxPadDef | null)[] = [
  // SPIN: plain = the held slip spin (lands on the beat); SHIFT = a REAL backspin — the record goes
  // back and plays on from there (operator, 2026-11-07: "let spin actually go back in the playhead
  // when shift spin and normal when no shift"), with no slip layer, because nothing continues.
  move("SPIN", "spin", "Backspin while held, landing on the beat · SHIFT = a real backspin that goes back and plays on", { shiftOn: (d) => d.spinback() }),
  move("CENSOR", "censor", "Reverse while held; on release it lands where the track would be"),
  move("BRAKE", "brake", "Power down while held; on release it lands where the track would be and keeps playing"),
  // CUT (operator, 2026-11-07: "lets do cut for #4"): the deck drops out while held and slams back
  // in where the track has got to. Not a stack move — it only mutes, so it layers over the others.
  { label: "CUT", hold: true, on: (d) => d.setCut(true), off: (d) => d.setCut(false), active: (d) => d.cutting, hint: "Silence the deck while held; it drops back in where the track has got to" },
  // WARP was tried and dropped (operator: "not a fan of warp at all"). Slot open.
  null,
  move("FREEZE", "freeze", "Holds this instant as a drone while held; the track runs on underneath and drops back in"),
  // 7–8: still being decided. Empty, not placeholders.
  null,
  null,
];
