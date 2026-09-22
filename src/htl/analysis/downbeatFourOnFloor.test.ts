import { describe, expect, it } from "vitest";
import { type AudioLike, detectBeatgrid } from "./analyze";

// TWO WAYS A GRID IS WRONG FOR THE RIGHT AUDIO, ON THE MATERIAL THIS APPLICATION IS MOSTLY USED FOR.
//
// Both matter because SYNC changes behaviour on them. AudioEngine.alignPhase bar-aligns when BOTH
// decks carry a downbeat — seeking the slave up to half a bar to put the two "1"s together — and
// otherwise aligns per-beat, which is always a minimal move. So a wrong downbeat is worse than no
// downbeat: it makes sync deliberately seek away from where the beats already matched. And a grid
// that sits half a beat off the kicks puts every cue, loop, snap and the phase lock itself on the
// offbeat.
//
// ★ WHAT THIS FILE IS NOT. It is synthetic material, so it establishes MECHANISM and THRESHOLD, not
// frequency. Nothing here says how much real music trips either of these. The first version of this
// test claimed the downbeat was "decided by noise" on four-on-the-floor; the measurement said
// otherwise — it is decided systematically, and it takes only a 1.15x accent to be right. That
// correction is why the thresholds below are stated as numbers rather than as alarm.

const SR = 48000;
const SECONDS = 60;
const IVL = 60 / 128;

/** Deterministic, so a moved answer is the stimulus changing and never the test flaking. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
}

interface Kit {
  /** Kick on beat 1 relative to the other three. 1 = a perfectly uniform four-on-the-floor. */
  oneGain: number;
  /** The kick's BEATER CLICK relative to its body. Every real kick has one; a pure sine sweep
   *  does not, and leaving it out is what made the first run of this look far worse than it is. */
  click: number;
  /** An offbeat hi-hat, relative to the kick body. */
  hat: number;
  seed: number;
  startOffset?: number;
}

function fourOnFloor(k: Kit): { buf: AudioLike; firstOneAt: number } {
  const length = Math.round(SECONDS * SR);
  const d = new Float32Array(length);
  const r = rng(k.seed);
  const click = rng(99); // the same click every hit — it is one drum, not a new sound each time
  const firstOneAt = 1 + (k.startOffset ?? 0);
  let beat = 0;
  for (let t = firstOneAt; t < SECONDS - 1; t += IVL, beat++) {
    const at = Math.round(t * SR);
    const gain = beat % 4 === 0 ? k.oneGain : 1;
    for (let i = 0; i < SR * 0.25 && at + i < length; i++) {
      const s = i / SR;
      d[at + i] += gain * Math.exp(-s * 18) * Math.sin(2 * Math.PI * (52 + 60 * Math.exp(-s * 40)) * s);
    }
    if (k.click > 0) for (let i = 0; i < SR * 0.006 && at + i < length; i++) d[at + i] += gain * k.click * Math.exp(-(i / SR) * 400) * click();
    if (k.hat > 0) {
      const ha = Math.round((t + IVL / 2) * SR);
      for (let i = 0; i < SR * 0.04 && ha + i < length; i++) d[ha + i] += Math.exp(-(i / SR) * 90) * r() * k.hat;
    }
  }
  for (let i = 0; i < length; i++) d[i] += r() * 0.002; // a room floor, so takes differ with the seed
  let peak = 0;
  for (const x of d) peak = Math.max(peak, Math.abs(x));
  if (peak > 0) for (let i = 0; i < length; i++) d[i] /= peak;
  return { buf: { sampleRate: SR, length, numberOfChannels: 1, getChannelData: () => d }, firstOneAt };
}

/** `gridOffset` — how far the detected grid sits from the kicks, in beats (0 = on them, ±0.5 = the
 *  offbeat). `barErr` — which beat of the bar was called "the one", relative to the real one. */
function measure(k: Kit): { gridOffset: number; barErr: number } {
  const { buf, firstOneAt } = fourOnFloor(k);
  const g = detectBeatgrid(buf);
  expect(g?.beats, "no tracked beats at all").toBeTruthy();
  const b = g!.beats!;
  let i = 0;
  for (let j = 1; j < b.length; j++) if (Math.abs(b[j] - firstOneAt) < Math.abs(b[i] - firstOneAt)) i = j;
  return {
    gridOffset: Math.round(((b[i] - firstOneAt) / IVL) * 1000) / 1000,
    barErr: g!.downbeat == null ? -1 : (((g!.downbeat - i) % 4) + 4) % 4,
  };
}

describe("four-on-the-floor grids", () => {
  it("the beat grid flips to the OFFBEAT when the hat's transient beats the kick's own", () => {
    // The kick's energy is all below ~110 Hz, where an onset envelope is slowest to rise. Its
    // beater click is the only fast transient it has, so what the tracker is really comparing is
    // that click against the hat. The margin is about 2:1 and nothing more.
    const rows: string[] = ["", "  grid offset from the kicks, in BEATS (0 = on the kicks, 0.46 = the offbeat)", "", "  kick click   hat 0     .05     .10     .20     .30"];
    const table: number[][] = [];
    for (const click of [0, 0.05, 0.1, 0.2, 0.4]) {
      const row = [0, 0.05, 0.1, 0.2, 0.3].map((hat) => measure({ oneGain: 1, click, hat, seed: 5 }).gridOffset);
      table.push(row);
      rows.push(`  ${String(click).padEnd(12)}${row.map((v) => String(v).padStart(7)).join(" ")}`);
    }
    rows.push("");
    console.log(rows.join("\n"));

    // With no hat at all the grid is on the kicks whatever the click is — the control that says a
    // flip is the hat's doing and not the click's.
    for (const row of table) expect(Math.abs(row[0])).toBeLessThan(0.1);
    // A clickless kick — a pure sub, which deep house and dub techno really do use — loses to a hat
    // at 5% of its amplitude, about 26 dB down. That is the case worth knowing.
    expect(table[0][1]).toBeGreaterThan(0.3);
    // And a kick with a healthy click holds against a hat four times louder than that.
    expect(Math.abs(table[4][3])).toBeLessThan(0.1);
  }, 240_000);

  it("the downbeat needs an accent on the one, and a very small one is enough", () => {
    // detectDownbeat picks the beat phase carrying the most LOW-BAND onset energy, because kicks
    // land on the one. In house and techno the kick lands on all four. The question is how much of
    // an accent it takes to break the tie.
    const takes: [number, number][] = [[1, 0], [2, 0], [3, 0], [1, IVL * 0.37], [2, IVL * 0.61], [3, IVL * 1.0]];
    const at = (oneGain: number) => takes.map(([seed, startOffset]) => measure({ oneGain, click: 0.2, hat: 0, seed, startOffset }).barErr);
    const flat = at(1);
    const nudged = at(1.15);
    console.log(`\n  bar-phase error (0 = correct):  uniform kick [${flat.join(", ")}]   1.15x accent [${nudged.join(", ")}]\n`);

    // A PERFECTLY uniform kick is wrong, and wrong by TWO beats — half a bar, the worst a 4/4 bar
    // alignment can be. It is also STABLE rather than random, so this is a systematic tie-break
    // (the partial bars at each end tilt the average), not a coin flip.
    expect(flat.filter((e) => e === 0).length).toBeLessThan(flat.length / 2);
    // But it takes almost nothing to fix: 1.15x is about 1.2 dB, below what most people would call
    // an accent, and it is right every time. So the failure needs a kick that is EXACTLY uniform.
    expect(nudged.every((e) => e === 0)).toBe(true);
  }, 240_000);
});
