// THE DOUBLE DROP — the most dramatic thing two records can do together.
//
// Two tracks that fit (tempos that lock, keys a step apart at most, both with energy to spare) are
// lined up so the INCOMING's drop lands on the same downbeat as the OUTGOING's last hook. For eight
// bars before it, the incoming's own build-up plays under the outgoing's pre-chorus, filtered and
// bass-less, so the room hears something coming without knowing what; one beat before, the low end
// drains out of both; then both drops hit at once — the incoming's bass and full spectrum, the
// outgoing's hook on top — and they ride together for eight bars before the outgoing is cut on a
// downbeat. It is Vande Veire & De Bie's "double drop" (the auto-DJ for drum & bass, 2018), with
// the cue rule that makes it work: the cue points are whole phrases apart, so the two structures
// line up rather than merely the beats.
//
// This file is the pure half: whether a pair qualifies and where everything goes (planDoubleDrop),
// and what every control does at any point of the 16 bars (doubleDropShape). The mixer applies it.
import type { Sections } from "./mixPoints";
import { dominantLabel, firstBodySection } from "./mixPoints";
import { camelotDistance } from "./mixability";
import type { EnergyArc, TransitionStyle } from "./types";
import type { AutoPerformance } from "../state/settings";

export const DD = {
  build: 8, // bars of the incoming's build under the outgoing's pre-chorus
  double: 8, // bars of both drops together
  breath: 7.75, // the last beat before the drop
  echoFrom: 14, // the outgoing starts to leave
};
export const DD_BARS = DD.build + DD.double;
const MIN_ENERGY = 0.6;

export interface DDSide {
  sections: Sections | null;
  bpm: number | null | undefined;
  key: string | null | undefined;
  energy: number | null | undefined;
}

/** Where a qualifying double drop goes, in each track's own seconds — or why not (null). */
export function planDoubleDrop(
  out: DDSide,
  inc: DDSide,
  o: {
    lockable: boolean;
    notBefore: number; // the outgoing's playhead + the time a cue needs
    arc: EnergyArc;
    lastStyle: TransitionStyle | null;
    perf: AutoPerformance;
  },
): { mixOut: number; drop: number; mixIn: number; incDrop: number } | null {
  if (o.perf === "subtle" || o.lastStyle === "doubleDrop" || !o.lockable) return null;
  if (!out.bpm || !inc.bpm || !out.sections || !inc.sections) return null;
  const kd = camelotDistance(out.key, inc.key);
  if (kd == null || kd > 1) return null; // two hooks at once are only consonant a step apart
  const eo = out.energy, ei = inc.energy;
  if (eo == null || ei == null || eo < MIN_ENERGY || ei < MIN_ENERGY) return null;
  if (o.arc !== "build" && ei < eo - 0.05) return null; // a wind-down never double-drops

  // The outgoing's LAST hook, long enough to hold eight bars of both drops.
  const s = out.sections;
  const hook = dominantLabel(s);
  if (!hook) return null;
  let i = -1;
  for (let j = s.labels.length - 1; j >= 0; j--) if (s.labels[j] === hook) { i = j; break; }
  if (i < 0) return null;
  const barOut = 240 / out.bpm;
  const drop = s.starts[i];
  const hookEnd = i + 1 < s.starts.length ? s.starts[i + 1] : s.lastSound;
  if (hookEnd - drop < DD.double * barOut - 0.5) return null;
  const mixOut = drop - DD.build * barOut;
  if (mixOut < o.notBefore || mixOut < s.firstSound) return null;

  // The incoming's drop: its first BODY section, with eight bars of its own lead-in before it.
  const t = inc.sections;
  const b = firstBodySection(t);
  if (b == null) return null;
  const incDrop = t.starts[b];
  const mixIn = incDrop - DD.build * (240 / inc.bpm);
  if (mixIn < 0) return null;
  return { mixOut, drop, mixIn, incDrop };
}

/** Every control at bars-elapsed `b` (0..16) of a double drop. `dropped`/`breath` come from the
 *  mixer's bar-line clock, so the moments land on the beat; the ramps use `b`. */
export function doubleDropShape(
  b: number,
  dropped: boolean,
  breath: boolean,
): {
  fader: number; // 0 = outgoing … 1 = incoming
  incFilter: number; // − = low-pass
  incLowDb: number;
  incHighDb: number;
  outLowDb: number;
  outHighDb: number;
  outFilter: number;
  outVocal: number; // stem gain, when the outgoing has stems
  echo: number; // delay mix on the outgoing as it leaves
} {
  const ss = (x: number) => {
    const t = Math.max(0, Math.min(1, x));
    return t * t * (3 - 2 * t);
  };
  const KILL = -26;
  if (!dropped) {
    const rise = ss(b / 6);
    return {
      fader: 0.35 * rise, // the build creeps up under the pre-chorus
      incFilter: -0.7 + 0.55 * ss(b / 7.5), // opening, but still dark — the drop is the reveal
      incLowDb: KILL,
      incHighDb: -6 + 4 * rise,
      outLowDb: breath ? KILL : 0, // the breath: the low end drains out of the room
      outHighDb: 0,
      outFilter: breath ? 0.45 : 0.12 * ss((b - 4) / 4), // a lift on the pre-chorus, then the inhale
      outVocal: 1,
      echo: 0,
    };
  }
  const leave = ss((b - DD.echoFrom) / (DD_BARS - DD.echoFrom));
  return {
    fader: 0.5, // both drops, together, until the cut at the end (settle)
    incFilter: 0,
    incLowDb: 0, // the bass is the incoming's from the one
    incHighDb: 0,
    outLowDb: KILL, // never two low ends
    outHighDb: -8 * leave,
    outFilter: 0.45 * leave,
    outVocal: 0, // never two lead vocals over the double
    echo: 0.55 * leave,
  };
}
