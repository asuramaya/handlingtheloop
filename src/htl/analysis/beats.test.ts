import { describe, expect, it } from "vitest";
import type { AudioLike } from "./analyze";
import { detectBeats } from "./beats";

// Integration test for the real FFT→chroma→structure pipeline (structure.test.ts covers the
// pure SSM/novelty/labelling math on hand-built feature vectors; this exercises the NEW code in
// beats.ts — buildChromaBinMap, the per-frame chroma accumulation, and detectStructure wiring —
// which nothing else touches).
//
// Synthesizes a click track (broadband transients at each beat, so DP beat tracking has
// something to lock onto) with a SUSTAINED TONE that changes chord partway through — a section
// change with essentially no loudness difference, i.e. exactly the case a loudness-only detector
// (the old detectPhrases) could not have found.
function synthTrack(opts: {
  bpm: number;
  beatsPerBar: number;
  barsA: number;
  barsB: number;
  freqsA: number[];
  freqsB: number[];
  sr?: number;
}): AudioLike {
  const { bpm, beatsPerBar, barsA, barsB, freqsA, freqsB, sr = 44100 } = opts;
  const beatSec = 60 / bpm;
  const totalBeats = (barsA + barsB) * beatsPerBar;
  const sectionASec = barsA * beatsPerBar * beatSec;
  const durSec = totalBeats * beatSec + 1; // +1s tail pad
  const n = Math.floor(durSec * sr);
  const data = new Float32Array(n);

  // Sustained chord tone, same loudness throughout (no energy cue) — only the pitch content
  // changes at the section boundary.
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const freqs = t < sectionASec ? freqsA : freqsB;
    let tone = 0;
    for (const f of freqs) tone += Math.sin(2 * Math.PI * f * t);
    data[i] = (tone * 0.15) / freqs.length;
  }
  // Click transients at every beat — broadband-ish decaying burst, for beat tracking to lock to.
  const clickLen = Math.floor(sr * 0.02);
  for (let beatIdx = 0; beatIdx * beatSec < durSec; beatIdx++) {
    const start = Math.floor(beatIdx * beatSec * sr);
    for (let k = 0; k < clickLen && start + k < n; k++) {
      const env = Math.exp(-k / (sr * 0.004));
      data[start + k] += env * 0.6 * Math.sin(2 * Math.PI * 2200 * (k / sr));
      data[start + k] += env * 0.4 * Math.sin(2 * Math.PI * 3700 * (k / sr));
    }
  }
  return {
    sampleRate: sr,
    length: n,
    numberOfChannels: 1,
    getChannelData: () => data,
  };
}

describe("detectBeats — structure detection integration (real FFT→chroma path)", () => {
  it("finds a section boundary near a pure chord change (no loudness cue) and labels it", () => {
    const bpm = 128;
    const beatsPerBar = 4;
    const barsA = 20;
    const barsB = 20;
    // Two clearly different triads (same octave range, same RMS) — a chroma-only cue.
    const buffer = synthTrack({ bpm, beatsPerBar, barsA, barsB, freqsA: [220, 277, 330], freqsB: [196, 247, 294] });

    const grid = detectBeats(buffer);
    expect(grid).not.toBeNull();
    if (!grid) return;

    // Tempo tracking should land in the right ballpark (synthetic clicks are easy material).
    expect(grid.bpm).toBeGreaterThan(bpm * 0.9);
    expect(grid.bpm).toBeLessThan(bpm * 1.1);

    expect(grid.phrases).toBeDefined();
    expect(grid.phraseLabels).toBeDefined();
    if (!grid.phrases || !grid.phraseLabels) return;
    expect(grid.phraseLabels.length).toBe(grid.phrases.length);
    expect(grid.phrases.length).toBeGreaterThanOrEqual(2); // bar 0 + at least the real transition

    // At least one detected boundary should land within a couple of bars of the true chord
    // change (barsA·beatsPerBar·beatSec) — the exact bar can drift a little with tracked-tempo
    // jitter, so allow a generous tolerance rather than an exact-bar match.
    const beatSec = 60 / bpm;
    const trueBoundarySec = barsA * beatsPerBar * beatSec;
    const barSec = beatsPerBar * beatSec;
    const nearBoundary = Array.from(grid.phrases).some((t) => Math.abs(t - trueBoundarySec) < barSec * 3);
    expect(nearBoundary).toBe(true);

    // Every label is a single letter.
    for (const l of grid.phraseLabels) expect(l).toMatch(/^[A-Z]$/);
  }, 20000);

  it("still produces a usable beatgrid (no crash) on a tonally uniform track", () => {
    const buffer = synthTrack({ bpm: 120, beatsPerBar: 4, barsA: 20, barsB: 20, freqsA: [220, 277, 330], freqsB: [220, 277, 330] });
    const grid = detectBeats(buffer);
    expect(grid).not.toBeNull();
  }, 20000);
});
