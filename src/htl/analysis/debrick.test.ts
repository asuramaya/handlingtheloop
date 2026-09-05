import { describe, it, expect } from "vitest";
import { debrick } from "./debrick";

// A synthetic track: a LOUD half followed by a QUIET half, as a min/max envelope.
// `secPerPx` is chosen so the follower's 1.2s time constant spans a sensible number of columns.
const SEC_PER_PX = 0.01; // 100 columns per second → tau ≈ 120 columns
function makeTrack(n: number, loudAmp: number, quietAmp: number) {
  const lo = new Float32Array(n);
  const hi = new Float32Array(n);
  for (let x = 0; x < n; x++) {
    // A little per-column texture so there is real local contrast to expand.
    const wobble = 0.85 + 0.15 * Math.sin(x * 0.7);
    const a = (x < n / 2 ? loudAmp : quietAmp) * wobble;
    hi[x] = a;
    lo[x] = -a;
  }
  return { lo, hi };
}
const meanHi = (hi: Float32Array, from: number, to: number) => {
  let s = 0;
  for (let x = from; x < to; x++) s += hi[x];
  return s / (to - from);
};

describe("debrick — the loudness reference", () => {
  const N = 1200;
  const LOUD = 0.95;
  const QUIET = 0.12;
  const TRACK_PEAK = LOUD; // what the pyramid's max-tree reports for the whole track

  it("draws a quiet section at the SAME height whether or not the loud part is on screen", () => {
    // THE BUG THIS GUARDS. `loud` scales the ceiling by how loud a section is compared with the
    // rest of the TRACK. When that reference came from the rendered columns it was
    // self-normalising: scroll until only the quiet half is in view and its own peak became the
    // reference, so a breakdown painted at full height. Same audio, different height, purely
    // because of where you were looking.
    const whole = makeTrack(N, LOUD, QUIET);
    debrick(whole.lo, whole.hi, N, SEC_PER_PX, TRACK_PEAK);
    const quietInContext = meanHi(whole.hi, (N * 3) / 4, N);

    // Now render ONLY the quiet half — a window scrolled fully into the breakdown.
    const alone = makeTrack(N / 2, QUIET, QUIET);
    debrick(alone.lo, alone.hi, N / 2, SEC_PER_PX, TRACK_PEAK);
    const quietAlone = meanHi(alone.hi, N / 4, N / 2);

    expect(quietAlone).toBeCloseTo(quietInContext, 2);
  });

  it("...and the window-local reference genuinely fails that, so the guard can go red", () => {
    // trackPeak = 0 selects the legacy window-local behaviour. If this ever stopped differing,
    // the test above would be passing for the wrong reason — it would no longer be measuring
    // anything. A guard that cannot fail is not a guard.
    const whole = makeTrack(N, LOUD, QUIET);
    debrick(whole.lo, whole.hi, N, SEC_PER_PX, 0);
    const quietInContext = meanHi(whole.hi, (N * 3) / 4, N);

    const alone = makeTrack(N / 2, QUIET, QUIET);
    debrick(alone.lo, alone.hi, N / 2, SEC_PER_PX, 0);
    const quietAlone = meanHi(alone.hi, N / 4, N / 2);

    expect(quietAlone).toBeGreaterThan(quietInContext * 2);
  });

  it("keeps a breakdown visibly lower than the drop", () => {
    const t = makeTrack(N, LOUD, QUIET);
    debrick(t.lo, t.hi, N, SEC_PER_PX, TRACK_PEAK);
    expect(meanHi(t.hi, N / 8, N / 3)).toBeGreaterThan(meanHi(t.hi, (N * 3) / 4, N) * 1.5);
  });

  it("leaves true silence at zero instead of lifting it off the line", () => {
    const n = 400;
    const lo = new Float32Array(n);
    const hi = new Float32Array(n);
    for (let x = 0; x < n; x++) {
      const a = x < n / 2 ? 0.8 : 0;
      hi[x] = a;
      lo[x] = -a;
    }
    debrick(lo, hi, n, SEC_PER_PX, 0.8);
    for (let x = n / 2 + 10; x < n; x++) expect(hi[x]).toBe(0);
  });

  it("keeps both edges of an asymmetric envelope in proportion", () => {
    const n = 400;
    const lo = new Float32Array(n);
    const hi = new Float32Array(n);
    for (let x = 0; x < n; x++) {
      hi[x] = 0.9 * (0.85 + 0.15 * Math.sin(x * 0.7));
      lo[x] = -0.3 * (0.85 + 0.15 * Math.sin(x * 0.7)); // a DC-offset-ish, one-sided wave
    }
    const ratioBefore = -lo[100] / hi[100];
    debrick(lo, hi, n, SEC_PER_PX, 0.9);
    expect(-lo[100] / hi[100]).toBeCloseTo(ratioBefore, 6);
  });

  it("is a no-op on a window too short to have a local contour", () => {
    const lo = Float32Array.from([-0.5, -0.5, -0.5]);
    const hi = Float32Array.from([0.5, 0.5, 0.5]);
    debrick(lo, hi, 3, SEC_PER_PX, 0.5);
    expect(Array.from(hi)).toEqual([0.5, 0.5, 0.5]);
  });
});

describe("debrick — a BRICK-WALLED master, which is the whole point of it", () => {
  const SEC_PER_PX2 = 0.01;
  const N = 1200;

  /** A limited master: the PEAK is pinned flat near full scale everywhere, while the real
   *  musical dynamics survive only in the energy — loud bars and a quiet bar, all at the same
   *  peak. This is the input de-brickwall exists for. */
  function bricked() {
    const lo = new Float32Array(N);
    const hi = new Float32Array(N);
    const energy = new Float32Array(N);
    for (let x = 0; x < N; x++) {
      hi[x] = 0.97 + 0.005 * Math.sin(x * 0.3); // pinned: a peak envelope with no contour
      lo[x] = -hi[x];
      // energy DOES have shape — a kick every 100 columns, and a quiet middle section
      const quiet = x > N * 0.45 && x < N * 0.6;
      const kick = Math.exp(-((x % 100) / 18));
      energy[x] = (quiet ? 0.18 : 1) * (0.25 + 0.75 * kick);
    }
    return { lo, hi, energy };
  }
  const spread = (a: Float32Array) => {
    const mean = a.reduce((s, v) => s + v, 0) / a.length;
    return Math.sqrt(a.reduce((s, v) => s + (v - mean) ** 2, 0) / a.length);
  };

  it("does NOT come out flatter than it went in", () => {
    // THE OPERATOR'S REPORT: "debrick on looks more bricked than off". Reading the PEAK envelope
    // there is no contour to expand, every column hit the degenerate branch, and the old code
    // substituted a constant — so the switch that promises to open a limited master up was
    // instead ironing it flat.
    const b = bricked();
    const before = spread(b.hi);
    debrick(b.lo, b.hi, N, SEC_PER_PX2, 0.97, b.energy, 1);
    expect(spread(b.hi)).toBeGreaterThan(before);
  });

  it("...and the PEAK envelope alone genuinely has nothing to give, which is why energy exists", () => {
    // The paired red proof. Same input, no energy curve — the peak is pinned flat, so there is
    // no contour to expand and the output is essentially the input. If this ever started
    // recovering shape on its own, the energy path would be solving a problem that had moved.
    const b = bricked();
    const before = spread(b.hi);
    debrick(b.lo, b.hi, N, SEC_PER_PX2, 0.97); // no energy → the old contrast source
    expect(spread(b.hi)).toBeLessThan(before * 3);
  });

  it("recovers the kicks and the quiet section that the peak envelope had erased", () => {
    const b = bricked();
    debrick(b.lo, b.hi, N, SEC_PER_PX2, 0.97, b.energy, 1);
    const mean = (from: number, to: number) => {
      let s = 0;
      for (let x = from; x < to; x++) s += b.hi[x];
      return s / (to - from);
    };
    // the quiet bar must render visibly lower than the loud material around it
    expect(mean(N * 0.48, N * 0.58)).toBeLessThan(mean(N * 0.05, N * 0.35) * 0.75);
  });

  it("changes nothing when there is no contour in EITHER measure", () => {
    // A genuinely featureless span has nothing to recover, and inventing a height for it is how
    // the old degenerate branch painted solid blocks. Saying nothing is the correct answer.
    const lo = new Float32Array(N).fill(-0.9);
    const hi = new Float32Array(N).fill(0.9);
    const flatEnergy = new Float32Array(N).fill(0.5);
    const copy = Float32Array.from(hi);
    debrick(lo, hi, N, SEC_PER_PX2, 0.9, flatEnergy, 1);
    expect(Array.from(hi)).toEqual(Array.from(copy));
  });
});

describe("debrick — silence must survive it", () => {
  const SPP = 0.01;
  const N = 1200;

  /** A stem lane that has not entered yet: the first 60% is effectively nothing (a hair above
   *  zero, as a real separated stem is — bleed, not digital silence), then it plays. */
  function lateEntry() {
    const lo = new Float32Array(N);
    const hi = new Float32Array(N);
    const energy = new Float32Array(N);
    for (let x = 0; x < N; x++) {
      const playing = x > N * 0.6;
      const wob = 0.8 + 0.2 * Math.sin(x * 0.5);
      const a = playing ? 0.85 * wob : 0.004 * wob; // ~0.5% of full scale = inaudible bleed
      hi[x] = a;
      lo[x] = -a;
      energy[x] = playing ? 0.9 * wob : 0.004 * wob;
    }
    return { lo, hi, energy };
  }
  const mean = (a: Float32Array, from: number, to: number) => {
    let s = 0;
    for (let x = from; x < to; x++) s += a[x];
    return s / (to - from);
  };

  it("leaves a stem that has not entered yet looking like it has not entered yet", () => {
    // THE OPERATOR'S SCREENSHOT: with de-brickwall on, the vocal and instrument lanes — silent
    // until bar 89 — rendered as continuous full-height bands across their whole lane. The
    // output formula added a constant 0.072 floor irrespective of loudness, so near-nothing was
    // magnified ~70x and "this stem is not playing" stopped being visible at all.
    const s2 = lateEntry();
    const quietBefore = mean(s2.hi, 0, N * 0.5);
    debrick(s2.lo, s2.hi, N, SPP, 0.85, s2.energy, 0.9);
    const quietAfter = mean(s2.hi, 0, N * 0.5);
    expect(quietAfter).toBeLessThan(quietBefore * 1.5); // never MAGNIFIED
    expect(quietAfter).toBeLessThan(0.05); // and still reads as silence against a 0.85 peak
  });

  it("still lets the part that IS playing keep its height", () => {
    const s2 = lateEntry();
    debrick(s2.lo, s2.hi, N, SPP, 0.85, s2.energy, 0.9);
    expect(mean(s2.hi, N * 0.75, N)).toBeGreaterThan(0.4);
  });

  it("keeps the played/silent contrast enormous, which is the whole readout", () => {
    const s2 = lateEntry();
    debrick(s2.lo, s2.hi, N, SPP, 0.85, s2.energy, 0.9);
    expect(mean(s2.hi, N * 0.75, N)).toBeGreaterThan(mean(s2.hi, 0, N * 0.5) * 20);
  });
});

describe("debrick — it must EXPAND local dynamics, not compress them", () => {
  const SPP = 0.01;
  const N = 1200;

  it("widens the local range inside a loud section instead of narrowing it", () => {
    // THE TEST THAT WOULD HAVE CAUGHT THE PEDESTAL. Everything else asserted macro behaviour —
    // breakdowns dip, silence stays silent — and all of it passed while the transform was quietly
    // squeezing every loud passage into a narrow band near the top of the lane, which is the
    // definition of the brickwalling it claims to undo.
    const lo = new Float32Array(N);
    const hi = new Float32Array(N);
    const energy = new Float32Array(N);
    for (let x = 0; x < N; x++) {
      // one loud section with real internal dynamics: hits, and gaps between them
      const hit = Math.exp(-((x % 60) / 10));
      const a = 0.25 + 0.7 * hit;
      hi[x] = a;
      lo[x] = -a;
      energy[x] = a;
    }
    const ratio = (a: Float32Array) => {
      const v = Array.from(a).sort((p, q) => p - q);
      return v[Math.floor(N * 0.9)] / Math.max(1e-6, v[Math.floor(N * 0.1)]);
    };
    const before = ratio(hi);
    debrick(lo, hi, N, SPP, 0.95, energy, 0.95);
    expect(ratio(hi)).toBeGreaterThan(before);
  });
});

describe("debrick — material that is ALREADY dynamic must come out untouched", () => {
  const SPP = 0.01;
  const N = 1200;

  /** A drum stem: sharp kicks with near-silent gaps. Local range ~45:1 — the opposite of
   *  brick-walled, and the exact content the operator saw ruined. */
  function drumStem() {
    const lo = new Float32Array(N);
    const hi = new Float32Array(N);
    const energy = new Float32Array(N);
    for (let x = 0; x < N; x++) {
      const a = 0.02 + 0.88 * Math.exp(-((x % 60) / 7));
      hi[x] = a;
      lo[x] = -a;
      energy[x] = a;
    }
    return { lo, hi, energy };
  }

  it("leaves a percussive stem essentially alone", () => {
    // THE OPERATOR'S REPORT: "on multi stem it makes it more brick walled (worse)". The gaps
    // between kicks were being lifted off the floor and the transients fattened into blocks,
    // because the transform maps every section onto a FIXED output range — which compresses
    // anything that arrived wider than that range.
    const d = drumStem();
    const before = Float32Array.from(d.hi);
    debrick(d.lo, d.hi, N, SPP, 0.9, d.energy, 0.9);
    let maxRel = 0;
    for (let x = 0; x < N; x++) maxRel = Math.max(maxRel, Math.abs(d.hi[x] - before[x]) / Math.max(before[x], 1e-6));
    expect(maxRel).toBeLessThan(0.05); // no column moves by more than 5%
  });

  it("does not fill in the gaps between hits", () => {
    // The gaps ARE the rhythm. Lifting them is what made the lane read as a solid block.
    const d = drumStem();
    const gapBefore = d.hi[55];
    debrick(d.lo, d.hi, N, SPP, 0.9, d.energy, 0.9);
    expect(d.hi[55]).toBeLessThan(gapBefore * 1.15);
  });

  it("still repairs a genuinely pinned master in the same call shape", () => {
    // The guard must be selective, not just cautious — otherwise it has only disabled the feature.
    const lo = new Float32Array(N);
    const hi = new Float32Array(N);
    const energy = new Float32Array(N);
    for (let x = 0; x < N; x++) {
      hi[x] = 0.96;
      lo[x] = -0.96;
      const quiet = x > N * 0.45 && x < N * 0.6;
      energy[x] = (quiet ? 0.2 : 1) * (0.3 + 0.7 * Math.exp(-((x % 80) / 14)));
    }
    debrick(lo, hi, N, SPP, 0.96, energy, 1);
    const mean = (from: number, to: number) => {
      let s = 0;
      for (let x = from; x < to; x++) s += hi[x];
      return s / (to - from);
    };
    expect(mean(N * 0.48, N * 0.58)).toBeLessThan(mean(N * 0.05, N * 0.35) * 0.8);
  });
});
