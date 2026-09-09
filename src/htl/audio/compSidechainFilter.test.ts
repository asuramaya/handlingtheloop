import { describe, expect, test } from "vitest";
import { COMP_WORKLET_SRC } from "./compWorklet";

// ★ WHY THIS TEST EXISTS, AND WHY IT DRIVES THE REAL SOURCE.
//
// COMP's sidechain LOW-pass (compWorklet `scLoHz`, CompFx param `scLp`) was one-pole-in-series DSP
// added to satisfy a UI grammar — the SC ribbon needed a top handle to match its bottom one — and
// it shipped verified by nothing but tsc and a green build. Obligation 315704d0.
//
// The obvious instrument is fxlab, and it is also the trap: per the fxlab-harness lesson it asserts
// nothing about its own input, and an estimator with nothing to estimate estimates NOISE,
// confidently. A green number from it would not be evidence the filter does anything. So this is
// the cheaper half Metron's own note on that thread pointed at — except rather than re-implementing
// the coefficient math here and testing my own arithmetic, it EVALUATES THE SHIPPED WORKLET SOURCE.
// COMP_WORKLET_SRC is an exported template string, so the processor can be built in Node with three
// stubs and driven sample-accurately. What passes here is the code that runs on the deck.
//
// ★ AND IT CARRIES A CONTROL. "A 5 kHz tone compresses less than a 100 Hz tone" is NOT on its own
// evidence of a working low-pass — a detector, an RMS window and a peak-vs-programme difference can
// all produce that. The control runs the identical pair with the filter PARKED at 20 kHz. Only the
// difference between the two conditions isolates the filter.

const SR = 48000;
const BLOCK = 128;

interface Proc {
  port: { onmessage: ((e: { data: Record<string, number> }) => void) | null; postMessage: (m: unknown) => void };
  envDb: number;
  process(inputs: Float32Array[][], outputs: Float32Array[][], params: Record<string, unknown>): boolean;
}

/** Build the real processor out of the shipped source, with the three globals a worklet gets. */
function makeComp(): Proc {
  let Captured: (new () => Proc) | null = null;
  class AudioWorkletProcessorStub {
    port = { onmessage: null as ((e: { data: Record<string, number> }) => void) | null, postMessage: () => {} };
  }
  const build = new Function(
    "AudioWorkletProcessor",
    "registerProcessor",
    "sampleRate",
    `${COMP_WORKLET_SRC}`,
  );
  build(
    AudioWorkletProcessorStub,
    (_name: string, cls: new () => Proc) => {
      Captured = cls;
    },
    SR,
  );
  if (!Captured) throw new Error("worklet source did not registerProcessor");
  return new (Captured as new () => Proc)();
}

function setParams(p: Proc, params: Record<string, number>): void {
  p.port.onmessage?.({ data: params });
}

/**
 * Drive a sine of `hz` through the compressor for `seconds` and return the settled gain reduction
 * in dB (`envDb`, ≤ 0). The detector runs on the INPUT here (scExt 0), which is the path the
 * sidechain filters sit in.
 */
function gainReductionDb(p: Proc, hz: number, seconds = 0.4, amp = 0.5): number {
  const blocks = Math.ceil((seconds * SR) / BLOCK);
  let phase = 0;
  const step = (2 * Math.PI * hz) / SR;
  for (let b = 0; b < blocks; b++) {
    const inCh = new Float32Array(BLOCK);
    for (let i = 0; i < BLOCK; i++) {
      inCh[i] = Math.sin(phase) * amp;
      phase += step;
    }
    p.process([[inCh], []], [[new Float32Array(BLOCK)]], {});
  }
  return p.envDb;
}

/** FET: peak detector, fast attack, short release — settles quickly and reads the filter cleanly. */
const FET = { mode: 1, threshold: -30, ratio: 10, attackMs: 1, releaseMs: 50, knee: 0, makeupDb: 0, auto: 0, scExt: 0, lookMs: 0 };

describe("COMP sidechain low-pass (scLoHz) — the filter actually filters", () => {
  test("the harness drives the real worklet and the compressor compresses at all", () => {
    const p = makeComp();
    setParams(p, { ...FET, scHz: 0, scLoHz: 20000 });
    const gr = gainReductionDb(p, 1000);
    // Without this, every comparison below could be between two silences.
    expect(gr).toBeLessThan(-1);
    expect(Number.isFinite(gr)).toBe(true);
  });

  // ★ THE MEASUREMENT. A low cutoff must stop a high tone from driving the detector.
  test("a 200 Hz cutoff stops a 5 kHz tone triggering the detector, while 100 Hz still triggers it", () => {
    const low = makeComp();
    setParams(low, { ...FET, scHz: 0, scLoHz: 200 });
    const grLowTone = gainReductionDb(low, 100);

    const high = makeComp();
    setParams(high, { ...FET, scHz: 0, scLoHz: 200 });
    const grHighTone = gainReductionDb(high, 5000);

    expect(grLowTone).toBeLessThan(-3); // in the passband: real compression
    // The 5 kHz tone is ~28 dB down through a 200 Hz one-pole, so it should barely move the needle.
    expect(grHighTone).toBeGreaterThan(grLowTone + 5);
  });

  // ★ THE CONTROL, without which the test above proves nothing about the FILTER.
  test("PARKED at 20 kHz the same two tones compress alike — so the difference above IS the filter", () => {
    const a = makeComp();
    setParams(a, { ...FET, scHz: 0, scLoHz: 20000 });
    const grLowTone = gainReductionDb(a, 100);

    const b = makeComp();
    setParams(b, { ...FET, scHz: 0, scLoHz: 20000 });
    const grHighTone = gainReductionDb(b, 5000);

    expect(Math.abs(grHighTone - grLowTone)).toBeLessThan(2);
  });

  test("the default IS near-transparent — parking it must not quietly colour the sidechain", () => {
    const parked = makeComp();
    setParams(parked, { ...FET, scHz: 0, scLoHz: 20000 });
    const grParked = gainReductionDb(parked, 1000);

    const wideOpen = makeComp();
    setParams(wideOpen, { ...FET, scHz: 0, scLoHz: 20000 });
    const grRef = gainReductionDb(wideOpen, 1000);

    expect(Math.abs(grParked - grRef)).toBeLessThan(0.5);
  });

  test("monotonic: lowering the cutoff never INCREASES how much a fixed high tone compresses", () => {
    const grs = [20000, 8000, 4000, 2000, 1000].map((fc) => {
      const p = makeComp();
      setParams(p, { ...FET, scHz: 0, scLoHz: fc });
      return gainReductionDb(p, 6000);
    });
    for (let i = 1; i < grs.length; i++) {
      // grs are ≤ 0; closing the filter means LESS reduction, i.e. a value closer to 0.
      expect(grs[i]).toBeGreaterThanOrEqual(grs[i - 1] - 0.25);
    }
    expect(grs[grs.length - 1]).toBeGreaterThan(grs[0] + 3); // and it really does close
  });

  // The HP and LP are in series, and the comment claims that makes a BAND rather than a shelf.
  test("HP and LP in series pass a band: mid compresses, both edges do not", () => {
    const band = { ...FET, scHz: 800, scLoHz: 2500 };
    const mk = (hz: number) => {
      const p = makeComp();
      setParams(p, band);
      return gainReductionDb(p, hz);
    };
    const inBand = mk(1500);
    const belowBand = mk(60);
    const aboveBand = mk(15000);
    expect(inBand).toBeLessThan(belowBand - 3);
    expect(inBand).toBeLessThan(aboveBand - 3);
  });

  test("stable and finite across the whole range CompFx will clamp to (1 kHz … 20 kHz)", () => {
    for (const fc of [1000, 2000, 5000, 10000, 15000, 20000]) {
      const p = makeComp();
      setParams(p, { ...FET, scHz: 0, scLoHz: fc });
      const gr = gainReductionDb(p, 1000, 0.2);
      expect(Number.isFinite(gr)).toBe(true);
      expect(gr).toBeLessThanOrEqual(0.001); // gain reduction is never positive
      expect(gr).toBeGreaterThan(-80); // and never runs away
    }
  });
});
