// FX2 PLATTER PATTERNS — DRAG · PUSH · RUB (operator, 2026-11-07: "not a fan of baby, scrib, or tear
// after hearing it performed … missing a piece where the actually shift the timeline"). Each is the
// RECORD'S OFFSET, in beats, as a function of beats since the press — a curve of platter motion (the
// idea of VirtualDJ's Scratch DNA). The JogEngine samples it each frame and the scratch resampler
// voices it, so speed and pitch come from the slope; a flat stretch is a still, silent record.
// DRAG and PUSH are hand moves that then LET THE RECORD PLAY (slope 1), which is what makes their
// SHIFT (commit) layer useful: the track carries on a beat behind / ahead. Timings are first guesses.

export type ScratchKind = "drag" | "push" | "rub";

const TAU = 2 * Math.PI;
/** Smooth 0→1 over u∈[0,1] (eased both ends: a hand starts and stops, it does not snap). */
const ease = (u: number) => (u <= 0 ? 0 : u >= 1 ? 1 : 0.5 - 0.5 * Math.cos(Math.PI * u));

/** Record offset in BEATS after `b` beats of the pattern. */
export function scratchOffset(kind: ScratchKind, b: number): number {
  switch (kind) {
    case "drag": {
      // pull the record back over half a beat (a slow, low groan), then let it play on — landing
      // exactly ONE beat behind the track (the stroke's own half beat counts: it ends at T − 1)
      const T = 0.5;
      return b < T ? (T - 1) * ease(b / T) : b - 1;
    }
    case "push": {
      // shove it forward over a quarter beat (a quick rising whoosh), then let it play on — exactly
      // ONE beat ahead of the track (the stroke ends at T + 1)
      const T = 0.25;
      return b < T ? (T + 1) * ease(b / T) : b + 1;
    }
    case "rub": {
      // a small rub back and forth on the spot, two strokes a beat, locked to the beat
      return 0.08 * Math.sin(TAU * 2 * b);
    }
  }
}
