// FX2 SCRATCH PATTERNS (operator, 2026-11-07: "use 6, 7, 8 for scratches/platter effects …
// remember they still need a shifted mode"). Each pattern is the RECORD'S OFFSET, in beats, as a
// function of beats elapsed — a curve of platter motion, the same idea as VirtualDJ's Scratch DNA.
// The JogEngine samples it every frame and the scratch resampler voices the motion, so speed and
// pitch come from the slope. A FLAT stretch is a still record, and a still record is silent: that is
// where the gaps in TEAR and STAB come from — no mute, the hand simply stops.
// Pairs (plain / SHIFT): BABY / DRAG (fast → slow) · SCRIBBLE / HYDROPLANE (in place → moving) ·
// TEAR / STAB (connected strokes → separate hits). Timings are first guesses, to tune by ear.

export type ScratchKind = "baby" | "drag" | "scribble" | "hydro" | "tear" | "stab";

const TAU = 2 * Math.PI;
const frac = (x: number) => x - Math.floor(x);
/** Smooth 0→1 over u∈[0,1] (eased both ends: a hand starts and stops, it does not snap). */
const ease = (u: number) => (u <= 0 ? 0 : u >= 1 ? 1 : 0.5 - 0.5 * Math.cos(Math.PI * u));

/** Record offset in BEATS after `b` beats of the pattern. */
export function scratchOffset(kind: ScratchKind, b: number): number {
  switch (kind) {
    case "baby": {
      // forward and back once per beat, smooth: the classic
      const A = 0.35;
      return A * (0.5 - 0.5 * Math.cos(TAU * b));
    }
    case "drag": {
      // the same motion slowed to two beats and pulled BACK: a heavy groan, then release
      const A = 0.5;
      return -A * (0.5 - 0.5 * Math.cos((TAU * b) / 2));
    }
    case "scribble": {
      // a tiny, very fast back-and-forth on the spot (sixteenths): a tense buzz
      return 0.035 * Math.sin(TAU * 4 * b);
    }
    case "hydro": {
      // the same buzz while the record keeps moving with the track: it judders along in time
      return b + 0.035 * Math.sin(TAU * 4 * b);
    }
    case "tear": {
      // the forward stroke broken into three quick pushes (with still gaps), then a smooth pull back
      const A = 0.3;
      const p = frac(b);
      if (p < 0.6) {
        const k = Math.min(2, Math.floor(p / 0.2));
        const u = (p - k * 0.2) / 0.15; // each push takes 0.15 of the beat, then 0.05 still
        return (A / 3) * (k + ease(u));
      }
      return A * (1 - ease((p - 0.6) / 0.4));
    }
    case "stab": {
      // a short, sharp push on each beat and stillness in between — the record walks forward in hits
      const A = 0.12;
      const n = Math.floor(b);
      return A * (n + ease(frac(b) / 0.15));
    }
  }
}
