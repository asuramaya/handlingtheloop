import { describe, expect, it } from "vitest";
import { type AudioLike, type Beatgrid, detectBeatgrid, localTempoDev } from "./analyze";

// HOW MUCH OF A REAL GRID'S WAVER IS THE MUSIC, AND HOW MUCH IS THE DETECTOR?
//
// The question is Metron's and it is load-bearing for the sync engine. localTempoDev reads local
// tempo deviation over a ±2-beat window and feeds it forward as a rate command; Deck.SYNC_TRIM_MAX
// is 0.06 for feed-forward AND phase correction together, and phaseCorrect hands the PI only
// `max(0, SYNC_TRIM_MAX − |ff|)`. So whatever the feed-forward asks for is taken out of the phase
// loop's authority. On the four real grids in scripts/synclab/real-grids.json the feed-forward wants
// 0.35%–3.12% RMS and up to 9.45% at its peaks.
//
// That is the loop doing its job IF the waver is real tempo movement. If it is detector resolution,
// the loop is spending its authority anticipating noise. Tracker error and rubato look identical
// inside a beats[] array — but a stimulus with NO tempo movement can separate them, because
// whatever spread comes back is the detector's by construction.
//
// ★ ONE STIMULUS WOULD BE THE SINE MISTAKE AGAIN, so this measures three axes and reports the whole
// surface: the MATERIAL (does a bass-heavy slow attack blur the onset more than an impulse), the
// TEMPO (the envelope is bucketed, so the floor depends on how a beat divides into buckets), and a
// RUBATO CONTROL that must make the numbers rise — an instrument that reports the same floor no
// matter what it is fed is not measuring anything.

const SR = 48000;
const SECONDS = 90;

type Voice = (d: Float32Array, at: number) => void;

const click: Voice = (d, at) => {
  for (let k = 0; k < 900 && at + k < d.length; k++) d[at + k] += Math.exp(-k / 140) * Math.sin((k / SR) * 2 * Math.PI * 180);
};
/** A club kick: most of its energy below 80 Hz, where an onset envelope is slowest to rise. */
const kick: Voice = (d, at) => {
  for (let k = 0; k < SR * 0.25 && at + k < d.length; k++) {
    const t = k / SR;
    d[at + k] += Math.exp(-t * 18) * Math.sin(2 * Math.PI * (52 + 60 * Math.exp(-t * 40)) * t);
  }
};
/** …with a tail, which is what smears a transient in a real mix. */
const kickTail: Voice = (d, at) => {
  kick(d, at);
  for (let k = 0; k < SR * 0.5 && at + k < d.length; k++) d[at + k] += Math.exp(-(k / SR) * 6) * (Math.random() * 2 - 1) * 0.05;
};
const hat: Voice = (d, at) => {
  for (let k = 0; k < SR * 0.04 && at + k < d.length; k++) d[at + k] += Math.exp(-(k / SR) * 90) * (Math.random() * 2 - 1) * 0.35;
};

/** `rubato` 0 means the beats are at exact multiples of 60/bpm, to the sample. */
function track(bpm: number, voices: { v: Voice; every: number; offset?: number }[], rubato = 0): AudioLike {
  const ivl = 60 / bpm;
  const length = Math.round(SECONDS * SR);
  const d = new Float32Array(length);
  for (const { v, every, offset = 0 } of voices) {
    let t = 1 + offset;
    let k = 0;
    while (t < SECONDS - 1) {
      v(d, Math.round(t * SR));
      t += ivl * every * (1 + rubato * Math.sin((k / 16) * 2 * Math.PI));
      k++;
    }
  }
  let peak = 0;
  for (const x of d) peak = Math.max(peak, Math.abs(x));
  if (peak > 0) for (let i = 0; i < length; i++) d[i] /= peak;
  return { sampleRate: SR, length, numberOfChannels: 1, getChannelData: () => d };
}

/** The numbers the sync engine's rows are in. The feed-forward is read through localTempoDev
 *  ITSELF rather than a re-implementation of its window — the engine's question, asked of the
 *  engine's own function. */
function spread(g: Beatgrid) {
  const b = g.beats!;
  const iv: number[] = [];
  for (let i = 1; i < b.length; i++) iv.push(b[i] - b[i - 1]);
  const m = iv.reduce((a, c) => a + c, 0) / iv.length;
  const ff = Array.from(b).map((t) => Math.abs(localTempoDev(g, t)));
  return {
    bpm: g.bpm,
    beats: b.length,
    rms: Math.sqrt(iv.reduce((a, c) => a + (c / m - 1) ** 2, 0) / iv.length),
    worst: Math.max(...iv.map((v) => Math.abs(v / m - 1))),
    ffRms: Math.sqrt(ff.reduce((a, c) => a + c * c, 0) / ff.length),
    ffWorst: Math.max(...ff),
  };
}

const pct = (x: number) => `${(x * 100).toFixed(2)}%`.padStart(8);

describe("the detector's own noise floor, on material with no tempo movement in it", () => {
  it("is set by the TEMPO, not by the material — and a rubato control proves it can see movement", () => {
    const material: [string, AudioLike][] = [
      ["impulse clicks", track(128, [{ v: click, every: 1 }])],
      ["kick only", track(128, [{ v: kick, every: 1 }])],
      ["kick + offbeat hats", track(128, [{ v: kick, every: 1 }, { v: hat, every: 0.5, offset: 60 / 128 / 2 }])],
      ["kick with a tail", track(128, [{ v: kickTail, every: 1 }, { v: hat, every: 0.5, offset: 60 / 128 / 2 }])],
    ];
    const out = ["", "  FLOOR vs MATERIAL, all at exactly 128.00 bpm", "", "  stimulus                  bpm   beats    ivl RMS   worst    ff RMS  ff worst"];
    const byMaterial = material.map(([name, buf]) => {
      const g = detectBeatgrid(buf);
      expect(g?.beats, `${name}: no tracked beats`).toBeTruthy();
      const s = spread(g!);
      out.push(`  ${name.padEnd(22)}${s.bpm.toFixed(2).padStart(7)}${String(s.beats).padStart(7)}${pct(s.rms)}${pct(s.worst)}${pct(s.ffRms)}${pct(s.ffWorst)}`);
      return s;
    });

    out.push("", "  FLOOR vs TEMPO, kick on every beat", "", "  input bpm          detected   beats    ivl RMS   worst    ff RMS  ff worst");
    const byTempo: { bpm: number; s: ReturnType<typeof spread> }[] = [];
    for (const bpm of [90, 100, 110, 120, 128, 135, 140, 150, 160, 165]) {
      const g = detectBeatgrid(track(bpm, [{ v: kick, every: 1 }]));
      expect(g?.beats, `${bpm}: no tracked beats`).toBeTruthy();
      const s = spread(g!);
      byTempo.push({ bpm, s });
      out.push(`  ${String(bpm).padEnd(22)}${s.bpm.toFixed(2).padStart(7)}${String(s.beats).padStart(7)}${pct(s.rms)}${pct(s.worst)}${pct(s.ffRms)}${pct(s.ffWorst)}`);
    }

    out.push("", "  THE CONTROL — real movement, which must read ABOVE the floor", "");
    const ctrl = [0, 0.03, 0.08].map((r) => {
      const s = spread(detectBeatgrid(track(128, [{ v: kick, every: 1 }], r))!);
      out.push(`  rubato ${(r * 100).toFixed(0).padStart(2)}%            ${s.bpm.toFixed(2).padStart(7)}${String(s.beats).padStart(7)}${pct(s.rms)}${pct(s.worst)}${pct(s.ffRms)}${pct(s.ffWorst)}`);
      return s;
    });
    out.push("", "  the real grids, for comparison (scripts/synclab/real-grids.json):");
    out.push("    bWcbFOSZkb0 steadiest      0.72%    4.40%   ff 0.35%    1.02%   ← at the floor");
    out.push("    gmzMGYIVrKc waviest        4.50%   13.20%   ff 3.12%    9.45%   ← well above it");
    out.push("");
    console.log(out.join("\n"));

    // THE CONTROL FIRST: if real movement does not read above no movement, nothing else here means
    // anything. 3% rubato must lift the feed-forward clear of the floor, and 8% clear of 3%.
    expect(ctrl[1].ffRms).toBeGreaterThan(ctrl[0].ffRms * 2);
    expect(ctrl[2].ffRms).toBeGreaterThan(ctrl[1].ffRms * 1.5);

    // THE MATERIAL DOES NOT MOVE IT. An impulse and a bass-heavy kick with a tail land on the same
    // floor to two decimals, which is what says the spread is the detector's resolution rather than
    // anything about how hard the onset is to find.
    const mrms = byMaterial.map((s) => s.ffRms);
    expect(Math.max(...mrms) - Math.min(...mrms)).toBeLessThan(0.002);

    // THE TEMPO DOES. Every tempo in the detector's own range is found exactly, and the floor still
    // varies several-fold across them — a beat divides into envelope buckets differently at each.
    for (const { bpm, s } of byTempo) expect(Math.abs(s.bpm - bpm), `${bpm} was not found exactly`).toBeLessThan(0.05);
    const trms = byTempo.map((r) => r.s.ffRms);
    expect(Math.max(...trms)).toBeGreaterThan(Math.min(...trms) * 2);

    // AND THE FLOOR IS LOW. The whole point: the feed-forward's noise from a perfectly steady track
    // stays well under 1% RMS, so a real grid asking for 3% is asking for something real.
    expect(Math.max(...trms)).toBeLessThan(0.01);
  }, 120_000);

  it("folds 170 and 174 bpm to half speed — outside the documented 85–175 clamp", () => {
    // beats.ts clamps to 85–175 deliberately (`while (bpm < 85) bpm *= 2; while (bpm > 175) bpm /= 2`)
    // and says the log-normal prior at ~125 exists "so octave errors don't win". 180 → 90 is that
    // clamp doing its job. 170 → 85 and 174 → 87 are NOT: both are inside the clamp, and the
    // material is a kick on every single beat with no tempo movement at all, so there is nothing
    // ambiguous to resolve. 174 is the canonical drum & bass tempo.
    //
    // This is recorded, not fixed: changing tempo detection invalidates every grid in the shared
    // pool and is an ANALYSIS_VERSION decision, not an autonomous one.
    for (const bpm of [170, 174]) {
      const g = detectBeatgrid(track(bpm, [{ v: kick, every: 1 }]));
      expect(g).not.toBeNull();
      expect(g!.bpm).toBeGreaterThan(bpm * 0.45);
      expect(g!.bpm, `${bpm} is no longer halved — if the detector improved, update this`).toBeLessThan(bpm * 0.55);
    }
    // …while everything inside 90–165 is found exactly, so this is a boundary, not a general failure.
    expect(detectBeatgrid(track(165, [{ v: kick, every: 1 }]))!.bpm).toBeCloseTo(165, 0);
  }, 120_000);
});
