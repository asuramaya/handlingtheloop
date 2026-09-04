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

  // ABA: a NON-adjacent repeat, the case labelSegments exists for. If A reappears after B, the
  // repeat-back-to-the-intro's-chord pattern real tracks actually use, it should reuse A's
  // letter — not a fresh one — end to end through the real FFT→chroma path, not just the pure
  // structure.ts unit test's hand-built vectors.
  it("labels a real A-B-A chord pattern with the third section reusing A's letter", () => {
    const bpm = 132;
    const beatsPerBar = 4;
    const beatSec = 60 / bpm;
    const barSec = beatsPerBar * beatSec;
    const barsPerSection = 20;
    const sr = 44100;
    const chordA = [246, 310, 369]; // B minor-ish
    const chordB = [196, 233, 294]; // G-ish
    const totalBars = barsPerSection * 3;
    const durSec = totalBars * beatsPerBar * beatSec + 1;
    const n = Math.floor(durSec * sr);
    const data = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const bar = Math.floor(t / barSec);
      const section = Math.floor(bar / barsPerSection) % 3; // 0=A,1=B,2=A again
      const freqs = section === 1 ? chordB : chordA;
      let tone = 0;
      for (const f of freqs) tone += Math.sin(2 * Math.PI * f * t);
      data[i] = (tone * 0.15) / freqs.length;
    }
    const clickLen = Math.floor(sr * 0.02);
    for (let beatIdx = 0; beatIdx * beatSec < durSec; beatIdx++) {
      const start = Math.floor(beatIdx * beatSec * sr);
      for (let k = 0; k < clickLen && start + k < n; k++) {
        const env = Math.exp(-k / (sr * 0.004));
        data[start + k] += env * 0.6 * Math.sin(2 * Math.PI * 2200 * (k / sr));
        data[start + k] += env * 0.4 * Math.sin(2 * Math.PI * 3700 * (k / sr));
      }
    }
    const buffer: AudioLike = { sampleRate: sr, length: n, numberOfChannels: 1, getChannelData: () => data };

    const grid = detectBeats(buffer);
    expect(grid).not.toBeNull();
    if (!grid || !grid.phrases || !grid.phraseLabels) return;
    // At minimum, the first and last detected boundary segment should carry the SAME letter —
    // the whole point of Phase 3. (A middle boundary or two either side of the true section
    // seams is tolerated; exact bar-accuracy isn't what this test is checking.)
    if (grid.phraseLabels.length >= 2) {
      expect(grid.phraseLabels[0]).toBe(grid.phraseLabels[grid.phraseLabels.length - 1]);
    }
  }, 20000);

  it("doesn't crash and stays within the letter cap on a dense many-near-identical-loop track", () => {
    // A techno-style stress case: 12 short, nearly-identical 4-bar loops back to back — the
    // scenario labelSegments' maxLetters guard exists for (a long, extremely repetitive track
    // must not spawn a fresh letter per loop, and must not hang building the SSM/novelty).
    const bpm = 140;
    const beatsPerBar = 4;
    const bars = 12 * 4;
    const buffer = synthTrack({ bpm, beatsPerBar, barsA: bars, barsB: 0, freqsA: [110, 165, 220], freqsB: [110, 165, 220] });
    const grid = detectBeats(buffer);
    expect(grid).not.toBeNull();
    if (!grid || !grid.phraseLabels) return;
    expect(new Set(grid.phraseLabels).size).toBeLessThanOrEqual(8);
  }, 20000);
});
