// ★ THE MASHUP — a stem transition played the way a DJ with four stem buttons per deck plays it,
// not a crossfade with extra steps (operator, 2026-11-05: "she wolf into memories ... it awkwardly
// rammed in memories half way through a verse at a peak, no looping or 'mixing' just transition,
// gotta lean more into the mixing part of it where it is actually using the power of the stems and
// the full arsenal/palette to give more of a mashup feeling during the transition instead of
// rushing the fade from a to b").
//
// Two pieces, both pure:
//
//  1. mashupGains — the choreography. The blend is cut into four phrases and every move happens ON
//     A BAR LINE, quickly, the way a hand presses a stem button — never as one long smear across
//     the whole blend, which is what made the old stem swap sound like a fade:
//        phrase 1  the new DRUMS come in under the old song (a little under it, so the two kits do
//                  not fight at full level);
//        phrase 2  the new MELODY joins; with a clashing or unknown key the old melody leaves as
//                  it does, so two harmonies never stack;
//        phrase 3  THE SWAP, on the one: drums and bass change hands in a beat, and the old track's
//                  VOCAL is left riding the new instrumental alone — the mashup;
//        phrase 4  the old vocal steps out and the new one comes in a bar later.
//     A pair whose keys are not known to agree skips the acapella-over-the-new-bed: its vocal
//     leaves at the swap instead, because a lead vocal over a bed in the wrong key is the one way
//     this move goes badly wrong.
//
//  2. chooseEntry — WHERE THE INCOMING STARTS. The old rule counted back from the incoming's first
//     repeated section by the blend's length, which can land anywhere — the middle of verse one at
//     full energy, as it did with Memories. A DJ starts the new record ON A PHRASE, as quiet as it
//     gets, timed so that its own next section arrives as the blend ends. So every candidate is a
//     section start; it is scored on where it lands (on a section boundary), how loud it is there
//     (quieter is better — an intro or a breakdown, not a chorus), and how far into the track it is.

import type { Sections } from "./mixPoints";

export type StemName = "drums" | "bass" | "other" | "vocals";
export type StemGains = Record<StemName, number>;

const smooth = (x: number) => {
  const t = x <= 0 ? 0 : x >= 1 ? 1 : x;
  return t * t * (3 - 2 * t);
};
/** 0 before `at` bars, 1 after `at + len`, an S-curve between (a stem button pressed over `len` bars). */
const press = (bar: number, at: number, len: number) => smooth((bar - at) / Math.max(1e-6, len));

export interface MashupOpts {
  /** Harmonically compatible AND the keys are actually known. Unknown is not permission. */
  keyOk: boolean;
}

/** The four phrase boundaries of a `bars`-long mashup, in bars from the mix start. */
export function mashupMarks(bars: number): { q1: number; q2: number; q3: number } {
  const q = Math.max(1, Math.round(bars / 4));
  return { q1: q, q2: 2 * q, q3: 3 * q };
}

/** Stem gains at `bar` bars into a `bars`-long mashup (fractional bars; 0 = mix start). */
export function mashupGains(bar: number, bars: number, opts: MashupOpts): { live: StemGains; inc: StemGains } {
  const { q1, q2, q3 } = mashupMarks(bars);
  const beat = 0.25; // a bar is four beats; the swaps are one beat long
  // INCOMING: drums first and a little under, then full at the swap; melody a phrase later; bass
  // exactly on the swap; vocal last, a bar after the old one starts leaving.
  const incDrums = 0.72 * press(bar, 0, 1) + 0.28 * press(bar, q2, beat);
  const incOther = (opts.keyOk ? 0.85 : 0.7) * press(bar, q1, 1) + (opts.keyOk ? 0.15 : 0.3) * press(bar, q2, 1);
  const incBass = press(bar, q2, beat);
  const incVox = opts.keyOk ? press(bar, q3 + 1, 1) : press(bar, q3, 1);
  // OUTGOING: the beat and the low end leave together on the swap's one; its melody leaves as the
  // new one arrives when the keys may clash, otherwise at the swap; the vocal holds over the new
  // instrumental for the third phrase (keyOk) and leaves into the fourth.
  const liveDrums = 1 - press(bar, q2, beat * 2);
  const liveBass = 1 - press(bar, q2, beat);
  const liveOther = opts.keyOk ? 1 - press(bar, q2, 1) : 1 - press(bar, q1, 0.5);
  const liveVox = opts.keyOk ? 1 - press(bar, q3, 1.5) : 1 - press(bar, q2, 1);
  return {
    live: { drums: liveDrums, bass: liveBass, other: liveOther, vocals: liveVox },
    inc: { drums: incDrums, bass: incBass, other: incOther, vocals: incVox },
  };
}

export interface EntryOpts {
  /** The earliest legal position (the track's first downbeat). */
  floor: number;
  /** Seconds per bar at the track's tempo. */
  secPerBar: number;
  /** Relative loudness (≈ 0..2, 1 = the track's average) of the stretch starting at t; null = unknown. */
  energyAt?: ((t: number) => number | null) | null;
}

/** Where to start the incoming track for a blend `blendSec` long. Always a section start (or the
 *  floor); see the header. Returns null when there is no structure to choose from. */
export function chooseEntry(s: Sections, blendSec: number, o: EntryOpts): number | null {
  if (!s.starts.length || o.secPerBar <= 0) return null;
  const limit = Math.max(o.floor, s.duration * 0.5); // never start the new record past its middle
  const cands = [o.floor, ...s.starts.filter((t) => t > o.floor + o.secPerBar && t <= limit)];
  let best: number | null = null;
  let bestScore = Infinity;
  for (const e of cands) {
    const arrive = e + blendSec;
    // Where the blend ends on the incoming: ideally ON a section boundary (its next part starts
    // just as the old track is gone). Measured in bars, capped — a miss of 4 bars is as bad as 8.
    let near = Infinity;
    for (const t of s.starts) near = Math.min(near, Math.abs(t - arrive));
    const landing = Math.min(4, near / o.secPerBar);
    // How loud it is where we drop the needle (an intro or a breakdown beats a chorus).
    const en = o.energyAt?.(e);
    const loud = en == null ? 0.6 : Math.max(0, Math.min(2, en));
    // How much of the record we skip — a little, for a better landing, is fine; half of it is not.
    const depth = (e - o.floor) / o.secPerBar;
    const score = landing * 0.8 + loud * 3 + depth * 0.06;
    if (score < bestScore - 1e-9) {
      bestScore = score;
      best = e;
    }
  }
  return best;
}
