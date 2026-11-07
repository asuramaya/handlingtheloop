import type { MoveKind } from "@htl/audio";
import type { FxPadDef } from "./fxPads";

// ★ FX2 IS THE MOVES BANK (operator, 2026-11-06: "transition tools are cool, maybe some of the
// effects and tools that are unmapped or do not have a clear space to be at could live in fx2 …
// lets try the first draft"). FX2 used to be the same eight effects as FX, aimed at the master
// chain, so with no stem chains it was an exact duplicate ("they feel the same"). FX stays the
// chain's effects; FX2 is eight DECK MOVES:
//   FREEZE · CENSOR · BRAKE · CUT / SPIN · DRAG · PUSH · RUB (plain = slip, SHIFT = commit)
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

// THE FX2 RULE (operator, 2026-11-07: "i want to standardize the feeling of all 8 fx2"):
//   plain = SLIP   — the move plays while held, the track runs on underneath, release lands on the beat
//   SHIFT = COMMIT — the same move, but it really moves the track: release carries on from wherever
//                    the move left the audio
// So every pad's SHIFT layer is its own move, committed (CUT's is a real pause). SHIFT no longer
// latches anywhere on this bank.
const both = (label: string, k: MoveKind, hint: string): FxPadDef =>
  move(label, k, hint, { shift: { on: (d) => d.moveDown(k, true), off: (d) => d.moveUp(k), active: (d) => d.moveHeld(k) } });

//   FREEZE · CENSOR · BRAKE · CUT
//   SPIN   · DRAG   · PUSH  · RUB
export const MOVE_PADS: (FxPadDef | null)[] = [
  both("FREEZE", "freeze", "Holds this instant as a drone, then lands on the beat · SHIFT = time stops: carries on from the frozen instant"),
  both("CENSOR", "censor", "Reverse, then land on the beat · SHIFT = a real reverse: plays on from where it reversed to"),
  both("BRAKE", "brake", "Power down, then land on the beat · SHIFT = a real power-down: spins back up from where it stopped"),
  {
    label: "CUT",
    hold: true,
    on: (d) => d.setCut(true),
    off: (d) => d.setCut(false),
    active: (d) => d.cutting,
    shift: { on: (d) => d.cutPause(true), off: (d) => d.cutPause(false), active: (d) => d.cutPaused },
    hint: "Silent while held, the track runs on · SHIFT = a pause: time stops and picks up where it left off",
  },
  both("SPIN", "spin", "Backspin, then land on the beat · SHIFT = a real backspin: plays on from where it spun back to"),
  both("DRAG", "drag", "Pull the record back a beat, then land on the beat · SHIFT = stay there: the track carries on a beat behind"),
  both("PUSH", "push", "Shove the record forward a beat, then land on the beat · SHIFT = stay there: the track carries on a beat ahead"),
  both("RUB", "rub", "Rub the record back and forth on the beat, then land · SHIFT = carry on from where the rub left it"),
];
