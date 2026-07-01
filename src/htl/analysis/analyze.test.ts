// Locks down the music-theory + beatgrid QUERY math in analyze.ts.
//
// Scope: ONLY the functions that take plain data (no AudioBuffer/FFT):
//   - Camelot key math: camelotParts, harmonicDistance, smartKeyShift, keyName, shiftKey
//   - Beatgrid queries over a literal Beatgrid: beatIndexBefore, beatPhase,
//     nearestBeat, beatTimeOffset, barAnchor, barPhase
// detectKey / detectBeatgridUniform / detectBeats / computePyramid need real audio
// + FFT and are deliberately out of scope.
import { describe, it, expect } from "vitest";
import {
  camelotParts,
  harmonicDistance,
  smartKeyShift,
  keyName,
  shiftKey,
  beatIndexBefore,
  beatPhase,
  localTempoDev,
  nearestBeat,
  beatTimeOffset,
  barAnchor,
  barPhase,
  foldTempoOctave,
  commonPhaseError,
  piTrim,
  serializeGrid,
  deserializeGrid,
  analyzeChannels,
  GRID_FORMAT_EPOCH,
  type Beatgrid,
  type KeyInfo,
} from "./analyze";
import { percussiveMag } from "./beats";

// --- helpers ---------------------------------------------------------------

// Camelot tonic tables mirror analyze.ts (0=C). B = major, A = minor.
const CAMELOT_MAJOR = ["8B", "3B", "10B", "5B", "12B", "7B", "2B", "9B", "4B", "11B", "6B", "1B"];
const CAMELOT_MINOR = ["5A", "12A", "7A", "2A", "9A", "4A", "11A", "6A", "1A", "8A", "3A", "10A"];
const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

function key(tonic: number, mode: "major" | "minor"): KeyInfo {
  return {
    tonic,
    mode,
    name: mode === "major" ? NOTE_NAMES[tonic] : `${NOTE_NAMES[tonic]}m`,
    camelot: (mode === "major" ? CAMELOT_MAJOR : CAMELOT_MINOR)[tonic],
  };
}

// A clean uniform dynamic grid: firstBeat=0, interval=0.5 (120 BPM), 4/4.
// beats = [0, 0.5, 1.0, 1.5, 2.0]
function uniformGridWithBeats(): Beatgrid {
  return {
    bpm: 120,
    firstBeat: 0,
    interval: 0.5,
    beats: new Float32Array([0, 0.5, 1.0, 1.5, 2.0]),
    beatsPerBar: 4,
    downbeat: 0,
  };
}

// Same uniform grid but WITHOUT beats[] — exercises the constant-comb fallback path.
function uniformGridNoBeats(): Beatgrid {
  return { bpm: 120, firstBeat: 0, interval: 0.5, beatsPerBar: 4 };
}

// ===========================================================================
// camelotParts
// ===========================================================================
describe("camelotParts", () => {
  it("parses minor (A side) — 8A → {num:8, major:false}", () => {
    expect(camelotParts("8A")).toEqual({ num: 8, major: false });
  });
  it("parses major (B side) — 8B → {num:8, major:true}", () => {
    expect(camelotParts("8B")).toEqual({ num: 8, major: true });
  });
  it("parses two-digit numbers — 12A / 11B", () => {
    expect(camelotParts("12A")).toEqual({ num: 12, major: false });
    expect(camelotParts("11B")).toEqual({ num: 11, major: true });
  });
  it("major flag is driven purely by a trailing 'B'", () => {
    expect(camelotParts("1B").major).toBe(true);
    expect(camelotParts("1A").major).toBe(false);
  });
  // NOTE: camelotParts is case-SENSITIVE: it checks endsWith("B") literally, so a
  // lowercase "8b" parses num=8 but major=false. This documents actual behaviour,
  // not an endorsement — callers only ever pass canonical upper-case codes.
  it("is case-sensitive on the side letter (lowercase 'b' is NOT treated as major)", () => {
    expect(camelotParts("8b")).toEqual({ num: 8, major: false });
  });
});

// ===========================================================================
// harmonicDistance
// ===========================================================================
describe("harmonicDistance", () => {
  it("same key → 0 (C major vs C major = 8B vs 8B)", () => {
    expect(harmonicDistance(key(0, "major"), key(0, "major"))).toBe(0);
  });

  it("perfect fifth on the same ring → 1 (C=8B vs G=9B)", () => {
    expect(harmonicDistance(key(0, "major"), key(7, "major"))).toBe(1);
    // fourth (the other ±1 neighbour): C=8B vs F=7B
    expect(harmonicDistance(key(0, "major"), key(5, "major"))).toBe(1);
  });

  it("relative major↔minor → 1 (C major=8B vs A minor=8A, same number, swap ring)", () => {
    expect(harmonicDistance(key(0, "major"), key(9, "minor"))).toBe(1);
    expect(harmonicDistance(key(9, "minor"), key(0, "major"))).toBe(1);
  });

  it("clash → ≥2 (C=8B vs D=10B is two steps on the same ring)", () => {
    expect(harmonicDistance(key(0, "major"), key(2, "major"))).toBe(2);
  });

  it("cross-ring non-relative is worse: distance = 1 + ring-step", () => {
    // C major = 8B (num 8) vs E minor = 9A (CAMELOT_MINOR[4]). |8-9|=1 -> 1+1 = 2.
    expect(camelotParts(key(4, "minor").camelot)).toEqual({ num: 9, major: false });
    expect(harmonicDistance(key(0, "major"), key(4, "minor"))).toBe(2);
    // A farther cross-ring pair: C major = 8B vs F# minor = 11A (num 11).
    // |8-11|=3 -> 1+3 = 4.
    expect(camelotParts(key(6, "minor").camelot)).toEqual({ num: 11, major: false });
    expect(harmonicDistance(key(0, "major"), key(6, "minor"))).toBe(4);
  });

  it("WRAPS around the 12-position ring: 12B and 1B are adjacent (distance 1)", () => {
    // CAMELOT_MAJOR: tonic 4 = 12B, tonic 11 = 1B. |12-1|=11 -> min(11,1)=1.
    expect(camelotParts("12B").num).toBe(12);
    expect(camelotParts("1B").num).toBe(1);
    expect(harmonicDistance(key(4, "major"), key(11, "major"))).toBe(1);
  });

  it("is symmetric", () => {
    const a = key(0, "major");
    const b = key(2, "minor");
    expect(harmonicDistance(a, b)).toBe(harmonicDistance(b, a));
  });
});

// ===========================================================================
// smartKeyShift
// ===========================================================================
describe("smartKeyShift", () => {
  it("returns 0 when already compatible (identical keys)", () => {
    expect(smartKeyShift(key(0, "major"), key(0, "major"))).toBe(0);
  });

  it("returns 0 when already a fifth apart (C major vs G major)", () => {
    expect(smartKeyShift(key(0, "major"), key(7, "major"))).toBe(0);
  });

  it("returns 0 when already relative (A minor vs C major) — mode is preserved by the shift", () => {
    expect(smartKeyShift(key(9, "minor"), key(0, "major"))).toBe(0);
  });

  it("finds the smallest-magnitude shift to reach compatibility", () => {
    // me = C# major (tonic 1). master = C major (8B).
    // Shifting me by -1 -> C major (8B) = same key, dist 0, |s|=1.
    // No 0-shift is compatible (C# vs C is a clash), so the minimal compatible move is -1.
    expect(smartKeyShift(key(1, "major"), key(0, "major"))).toBe(-1);
  });

  it("respects the ±range bound (range 0 can never move, returns best-in-range = 0)", () => {
    // With range 0 the only candidate is s=0; even if incompatible it must return 0.
    // (May be -0; compare numerically.)
    expect(smartKeyShift(key(1, "major"), key(0, "major"), 0)).toBeCloseTo(0, 10);
  });

  it("prefers a compatible key in range over a closer-but-dissonant one", () => {
    // me = D major (tonic 2, 10B), master = C major (8B): clash dist 2 at s=0.
    // s=-2 -> C major (8B): dist 0. s=+? ... smallest |s| compatible should be chosen.
    const s = smartKeyShift(key(2, "major"), key(0, "major"));
    // landing key must be compatible (distance <= 1) with master.
    expect(harmonicDistance(shiftKey(key(2, "major"), s), key(0, "major"))).toBeLessThanOrEqual(1);
    expect(Math.abs(s)).toBeLessThanOrEqual(12);
  });
});

// ===========================================================================
// keyName
// ===========================================================================
describe("keyName", () => {
  it("major → bare note name (C, G)", () => {
    expect(keyName(0, "major")).toBe("C");
    expect(keyName(7, "major")).toBe("G");
  });
  it("minor → note name + 'm' (Am, F#m)", () => {
    expect(keyName(9, "minor")).toBe("Am");
    expect(keyName(6, "minor")).toBe("F#m");
  });
});

// ===========================================================================
// shiftKey
// ===========================================================================
describe("shiftKey", () => {
  it("transposes the tonic, mode unchanged (C major +7 → G major / 9B)", () => {
    const out = shiftKey(key(0, "major"), 7);
    expect(out.tonic).toBe(7);
    expect(out.mode).toBe("major");
    expect(out.name).toBe("G");
    expect(out.camelot).toBe("9B");
  });

  it("wraps past 12 (B major=11, +2 → C# major / tonic 1)", () => {
    const out = shiftKey(key(11, "major"), 2);
    expect(out.tonic).toBe(1);
    expect(out.name).toBe("C#");
  });

  it("wraps on negative shifts (C major -1 → B major / tonic 11)", () => {
    const out = shiftKey(key(0, "major"), -1);
    expect(out.tonic).toBe(11);
    expect(out.name).toBe("B");
    expect(out.mode).toBe("major");
  });

  it("keeps minor mode and updates the A-side camelot (A minor +3 → C minor)", () => {
    const out = shiftKey(key(9, "minor"), 3);
    expect(out.tonic).toBe(0);
    expect(out.mode).toBe("minor");
    expect(out.name).toBe("Cm");
    expect(out.camelot).toBe(CAMELOT_MINOR[0]); // "5A"
  });

  it("a +12 shift is identity on the tonic", () => {
    const out = shiftKey(key(3, "minor"), 12);
    expect(out.tonic).toBe(3);
    expect(out.mode).toBe("minor");
  });
});

// ===========================================================================
// beatIndexBefore (binary search over the dynamic beats[] array)
// beats = [0, 0.5, 1.0, 1.5, 2.0]
// ===========================================================================
describe("beatIndexBefore", () => {
  const beats = new Float32Array([0, 0.5, 1.0, 1.5, 2.0]);

  it("returns -1 for t before the first beat", () => {
    expect(beatIndexBefore(beats, -0.1)).toBe(-1);
  });
  it("returns 0 exactly on the first beat", () => {
    expect(beatIndexBefore(beats, 0)).toBe(0);
  });
  it("returns the at-or-before index for an interior time", () => {
    expect(beatIndexBefore(beats, 0.7)).toBe(1); // between beat 1 (0.5) and 2 (1.0)
    expect(beatIndexBefore(beats, 1.0)).toBe(2); // exactly on a beat -> that beat
    expect(beatIndexBefore(beats, 1.49)).toBe(2);
  });
  it("returns the last index for t at or past the final beat", () => {
    expect(beatIndexBefore(beats, 2.0)).toBe(4);
    expect(beatIndexBefore(beats, 10)).toBe(4);
  });
});

// ===========================================================================
// percussiveMag — the drum-DSP gridding pass (transient emphasis for onsets)
// ===========================================================================
describe("percussiveMag (percussive-emphasis onset front-end)", () => {
  it("mix=0 → plain log-magnitude, ignores the harmonic estimate", () => {
    expect(percussiveMag(5, 3, 0)).toBeCloseTo(Math.log1p(5), 10);
    expect(percussiveMag(5, 0, 0)).toBeCloseTo(Math.log1p(5), 10);
  });
  it("mix=1, no sustained level → all transient (equals plain)", () => {
    expect(percussiveMag(5, 0, 1)).toBeCloseTo(Math.log1p(5), 10);
  });
  it("mix=1, fully sustained (harm==raw) → zero onset (tone suppressed)", () => {
    expect(percussiveMag(5, 5, 1)).toBeCloseTo(0, 10);
    expect(percussiveMag(5, 9, 1)).toBeCloseTo(0, 10); // harm>raw → excess clamped to 0
  });
  it("blends transient excess with raw by mix", () => {
    expect(percussiveMag(5, 3, 0.5)).toBeCloseTo(0.5 * Math.log1p(5) + 0.5 * Math.log1p(2), 10);
  });
  it("is monotonically NON-increasing as the sustained level rises (more suppression)", () => {
    const a = percussiveMag(5, 1, 0.7);
    const b = percussiveMag(5, 3, 0.7);
    const c = percussiveMag(5, 5, 0.7);
    expect(a).toBeGreaterThan(b);
    expect(b).toBeGreaterThan(c);
  });
  it("a transient towering over its baseline stays crisp; an equal-amplitude sustained tone is cut", () => {
    const transient = percussiveMag(8, 1, 0.7); // hit over a quiet background
    const sustained = percussiveMag(8, 7.5, 0.7); // same magnitude but it's the ongoing level
    expect(transient).toBeGreaterThan(sustained * 1.5);
  });
});

// ===========================================================================
// localTempoDev
// ===========================================================================
describe("localTempoDev (rubato feed-forward)", () => {
  it("returns 0 for a uniform grid (no dynamic beats[])", () => {
    expect(localTempoDev({ bpm: 120, firstBeat: 0, interval: 0.5 }, 1.0)).toBe(0);
  });
  it("returns ~0 for an evenly-spaced dynamic grid (on-tempo)", () => {
    const g: Beatgrid = { bpm: 120, firstBeat: 0, interval: 0.5, beats: new Float32Array([0, 0.5, 1, 1.5, 2, 2.5, 3]) };
    expect(localTempoDev(g, 1.5)).toBeCloseTo(0, 6);
  });
  it("positive where beats run locally CLOSER (faster than the grid average)", () => {
    // avg interval 0.5, but a 0.4-spaced fast pocket in the middle
    const g: Beatgrid = { bpm: 120, firstBeat: 0, interval: 0.5, beats: new Float32Array([0, 0.5, 1.0, 1.4, 1.8, 2.2, 2.6, 3.1, 3.6]) };
    expect(localTempoDev(g, 1.9)).toBeGreaterThan(0.1); // ~+0.25
  });
  it("negative where beats run locally WIDER (slower than the grid average)", () => {
    const g: Beatgrid = { bpm: 120, firstBeat: 0, interval: 0.5, beats: new Float32Array([0, 0.5, 1.0, 1.7, 2.4, 3.1, 3.6, 4.1]) };
    expect(localTempoDev(g, 2.4)).toBeLessThan(0);
  });
  it("returns 0 before the first tracked beat (out of range)", () => {
    const g: Beatgrid = { bpm: 120, firstBeat: 1, interval: 0.5, beats: new Float32Array([1, 1.5, 2, 2.5]) };
    expect(localTempoDev(g, 0.2)).toBe(0);
  });
  it("clamps an absurd local deviation to ±0.5 (rejects grid glitches)", () => {
    const g: Beatgrid = { bpm: 120, firstBeat: 0, interval: 0.5, beats: new Float32Array([0, 0.05, 0.1, 0.15, 0.2, 0.25]) };
    expect(localTempoDev(g, 0.12)).toBeCloseTo(0.5, 6); // 0.5/0.05 − 1 = 9 → clamped to 0.5
  });
});

// ===========================================================================
// beatPhase
// ===========================================================================
describe("beatPhase", () => {
  it("dynamic grid: 0 on a beat, 0.5 halfway, in [0,1)", () => {
    const g = uniformGridWithBeats();
    expect(beatPhase(g, 0)).toBeCloseTo(0, 6);
    expect(beatPhase(g, 0.25)).toBeCloseTo(0.5, 6);
    expect(beatPhase(g, 0.5)).toBeCloseTo(0, 6);
    const p = beatPhase(g, 0.9);
    expect(p).toBeGreaterThanOrEqual(0);
    expect(p).toBeLessThan(1);
  });

  it("uniform (no beats[]) grid behaves identically on the comb", () => {
    const g = uniformGridNoBeats();
    expect(beatPhase(g, 0)).toBeCloseTo(0, 6);
    expect(beatPhase(g, 0.25)).toBeCloseTo(0.5, 6);
    expect(beatPhase(g, 0.5)).toBeCloseTo(0, 6);
  });

  it("returns a phase in [0,1) before the first beat (back-extrapolation)", () => {
    const g = uniformGridWithBeats();
    const p = beatPhase(g, -0.25); // half a beat before beat 0
    expect(p).toBeGreaterThanOrEqual(0);
    expect(p).toBeLessThan(1);
    expect(p).toBeCloseTo(0.5, 6);
  });
});

// ===========================================================================
// nearestBeat
// ===========================================================================
describe("nearestBeat", () => {
  it("snaps to the closer beat", () => {
    const g = uniformGridWithBeats();
    expect(nearestBeat(g, 0.3)).toBeCloseTo(0.5, 6); // closer to 0.5 than 0
    expect(nearestBeat(g, 0.1)).toBeCloseTo(0.0, 6); // closer to 0
  });

  it("tie at the exact midpoint resolves to the LOWER beat", () => {
    const g = uniformGridWithBeats();
    // 0.25 is equidistant from 0 and 0.5; code uses <= so lower (0) wins.
    expect(nearestBeat(g, 0.25)).toBeCloseTo(0.0, 6);
  });

  it("before the first beat → the first beat; past the last → the last beat", () => {
    const g = uniformGridWithBeats();
    expect(nearestBeat(g, -1)).toBeCloseTo(0, 6);
    expect(nearestBeat(g, 5)).toBeCloseTo(2.0, 6);
  });

  it("uniform (no beats[]) rounds to the nearest comb position", () => {
    const g = uniformGridNoBeats();
    expect(nearestBeat(g, 0.3)).toBeCloseTo(0.5, 6);
    expect(nearestBeat(g, 1.24)).toBeCloseTo(1.0, 6);
  });
});

// ===========================================================================
// beatTimeOffset — exact arithmetic on a uniform grid
// ===========================================================================
describe("beatTimeOffset", () => {
  it("integer beats away land exactly (dynamic grid)", () => {
    const g = uniformGridWithBeats();
    expect(beatTimeOffset(g, 0, 4)).toBeCloseTo(2.0, 6); // 4 beats from beat 0
    expect(beatTimeOffset(g, 0.5, 1)).toBeCloseTo(1.0, 6); // 1 beat after beat 1
    expect(beatTimeOffset(g, 1.0, 2)).toBeCloseTo(2.0, 6);
  });

  it("fractional (sub-beat) offsets interpolate within the interval", () => {
    const g = uniformGridWithBeats();
    expect(beatTimeOffset(g, 0, 0.25)).toBeCloseTo(0.125, 6); // quarter of a 0.5s beat
    expect(beatTimeOffset(g, 0, 0.0625)).toBeCloseTo(0.03125, 6); // 1/16 loop slice
    expect(beatTimeOffset(g, 0, 0.5)).toBeCloseTo(0.25, 6);
  });

  it("negative offsets extrapolate before the tracked range (no NaN)", () => {
    const g = uniformGridWithBeats();
    // index -1 = beats[0] + (-1)*(beats[1]-beats[0]) = -0.5
    expect(beatTimeOffset(g, 0, -1)).toBeCloseTo(-0.5, 6);
    expect(Number.isNaN(beatTimeOffset(g, 0, -1))).toBe(false);
  });

  it("offsets past the last tracked beat extrapolate at the edge interval", () => {
    const g = uniformGridWithBeats(); // last beat 2.0 at index 4
    // from beat 4 (t=2.0), +2 beats -> 3.0 by edge interval 0.5
    expect(beatTimeOffset(g, 2.0, 2)).toBeCloseTo(3.0, 6);
  });

  it("uniform (no beats[]) is pure arithmetic: base + n*interval", () => {
    const g = uniformGridNoBeats();
    expect(beatTimeOffset(g, 0, 3)).toBeCloseTo(1.5, 6);
    expect(beatTimeOffset(g, 0, 0.25)).toBeCloseTo(0.125, 6);
    expect(beatTimeOffset(g, 1.0, -2)).toBeCloseTo(0.0, 6);
  });
});

// ===========================================================================
// barAnchor / barPhase — 4/4, downbeat at beat index 0
// bars: [0,2.0) and [2.0,4.0), each 4*0.5 = 2.0s long
// ===========================================================================
describe("barAnchor", () => {
  it("returns the containing bar's start and length (first bar)", () => {
    const g = uniformGridWithBeats();
    const bar = barAnchor(g, 0.7); // inside bar [0,2.0)
    expect(bar.start).toBeCloseTo(0, 6);
    expect(bar.length).toBeCloseTo(2.0, 6); // 4 beats * 0.5s
  });

  it("on a downbeat the bar starts exactly there", () => {
    const g = uniformGridWithBeats();
    const bar = barAnchor(g, 0);
    expect(bar.start).toBeCloseTo(0, 6);
    expect(bar.length).toBeCloseTo(2.0, 6);
  });

  it("uniform (no beats[]) anchors bars at firstBeat in barLen steps", () => {
    const g = uniformGridNoBeats();
    const b0 = barAnchor(g, 0.7);
    expect(b0.start).toBeCloseTo(0, 6);
    expect(b0.length).toBeCloseTo(2.0, 6);
    const b1 = barAnchor(g, 2.3); // second bar
    expect(b1.start).toBeCloseTo(2.0, 6);
    expect(b1.length).toBeCloseTo(2.0, 6);
  });
});

describe("barPhase", () => {
  it("0 on the downbeat, in [0,1) across the bar", () => {
    const g = uniformGridWithBeats();
    expect(barPhase(g, 0)).toBeCloseTo(0, 6);
    // half a bar in (bar is 2.0s): t=1.0 -> 0.5
    const p = barPhase(g, 1.0);
    expect(p).toBeGreaterThanOrEqual(0);
    expect(p).toBeLessThan(1);
    expect(p).toBeCloseTo(0.5, 6);
  });

  it("uniform grid: quarter-bar in → 0.25", () => {
    const g = uniformGridNoBeats();
    expect(barPhase(g, 0.5)).toBeCloseTo(0.25, 6); // 0.5 / 2.0
  });
});

// foldTempoOctave — the half/double BPM fold shared by SYNC (matchSlaveTempo) and the auto-mix
// glide. The null guard is load-bearing: a degenerate 0/NaN BPM grid used to spin the raw
// while-loop forever and FREEZE the thread (Infinity/2 = Infinity, 0×2 = 0).
describe("foldTempoOctave", () => {
  it("identical tempo folds to itself", () => {
    expect(foldTempoOctave(128, 128)).toBeCloseTo(128, 6);
  });

  it("folds a double-tempo target DOWN into the reference octave (256 vs 128 → 128)", () => {
    expect(foldTempoOctave(256, 128)).toBeCloseTo(128, 6);
  });

  it("folds a half-tempo target UP (64 vs 128 → 128)", () => {
    expect(foldTempoOctave(64, 128)).toBeCloseTo(128, 6);
  });

  it("a genuine ≤√2 spread is left alone (140 vs 128 stays 140)", () => {
    expect(foldTempoOctave(140, 128)).toBeCloseTo(140, 6);
  });

  it("result always lands in [ref/√2, ref·√2]", () => {
    for (const t of [60, 75, 90, 128, 174, 200, 33.3]) {
      const f = foldTempoOctave(t, 128)!;
      expect(f).toBeGreaterThanOrEqual(128 / Math.SQRT2 - 1e-9);
      expect(f).toBeLessThanOrEqual(128 * Math.SQRT2 + 1e-9);
    }
  });

  it("the exact √2 boundary does not oscillate (returns finite)", () => {
    const f = foldTempoOctave(128 * Math.SQRT2, 128)!;
    expect(Number.isFinite(f)).toBe(true);
  });

  // The hang guards — each of these would spin the old raw while-loop forever.
  it("returns null on a 0-BPM reference grid (the thread-freeze case)", () => {
    expect(foldTempoOctave(128, 0)).toBeNull();
  });

  it("returns null on a 0-BPM target (master stopped at -100% tempo → effectiveBpm 0)", () => {
    expect(foldTempoOctave(0, 128)).toBeNull();
  });

  it("returns null on NaN / Infinity / negative inputs", () => {
    expect(foldTempoOctave(NaN, 128)).toBeNull();
    expect(foldTempoOctave(128, NaN)).toBeNull();
    expect(foldTempoOctave(Infinity, 128)).toBeNull();
    expect(foldTempoOctave(128, Infinity)).toBeNull();
    expect(foldTempoOctave(-128, 128)).toBeNull();
    expect(foldTempoOctave(128, -1)).toBeNull();
  });
});

// commonPhaseError — the SYNC phase-lock sensor fix. When the two grids differ in density
// (fold ≈ 2 / 0.5 = a half/double-detected octave), the raw phase difference cycles at 2× and the
// loop chases forever. Folding both phases onto the audible beat makes the error well-posed.
describe("commonPhaseError", () => {
  const wrap = (e: number) => Math.abs(e) <= 0.5 + 1e-9;

  it("fold ≈ 1 (no octave gap) is the plain wrapped difference — no regression on matched pairs", () => {
    expect(commonPhaseError(0.3, 0.3, 1)).toBeCloseTo(0, 9);
    expect(commonPhaseError(0.4, 0.1, 1)).toBeCloseTo(0.3, 9);
    expect(commonPhaseError(0.1, 0.4, 1)).toBeCloseTo(-0.3, 9);
    expect(commonPhaseError(0.95, 0.05, 1)).toBeCloseTo(-0.1, 9); // wraps the long way round
  });

  it("a tiny tempo mismatch (fold 0.998) still counts as no fold", () => {
    expect(commonPhaseError(0.4, 0.1, 0.998)).toBeCloseTo(0.3, 9);
  });

  it("THE FIX: master half-way through its DOUBLE-length beat reads as ALIGNED, not max-error", () => {
    // fold=2 → master grid is coarser (its beat spans 2 audible beats). Master at phase 0.5 is on
    // the audible downbeat of its 2nd sub-beat → aligned with the slave at 0. Old code: err=−0.5
    // (max, the chase). New: 0.
    expect(commonPhaseError(0.0, 0.5, 2)).toBeCloseTo(0, 9);
    expect(commonPhaseError(0.5, 0.25, 2)).toBeCloseTo(0, 9); // both land on the audible mid-beat
    expect(commonPhaseError(0.5, 0.75, 2)).toBeCloseTo(0, 9); // master's 2nd sub-beat, same audible phase
  });

  it("symmetric: fold = 0.5 (slave grid coarser) folds the SLAVE phase up", () => {
    expect(commonPhaseError(0.5, 0.0, 0.5)).toBeCloseTo(0, 9);
    expect(commonPhaseError(0.25, 0.5, 0.5)).toBeCloseTo(0, 9);
  });

  it("a genuine offset survives the fold (not everything collapses to 0)", () => {
    // fold=2, slave at 0.1, master at 0.0 (audible 0.0) → err 0.1.
    expect(commonPhaseError(0.1, 0.0, 2)).toBeCloseTo(0.1, 9);
  });

  it("anything past the √2 fold boundary is treated as a 2× gap (matches matchSlaveTempo)", () => {
    // fold=1.5 → round(log2)=1 → octave gap → master scaled ×2. 0.5 master → audible 0.
    expect(commonPhaseError(0.0, 0.5, 1.5)).toBeCloseTo(0, 9);
    // fold=1.3 (< √2) → no gap → plain difference.
    expect(commonPhaseError(0.0, 0.5, 1.3)).toBeCloseTo(-0.5, 9);
  });

  it("null / non-finite fold → no scaling (plain wrapped difference)", () => {
    expect(commonPhaseError(0.4, 0.1, null)).toBeCloseTo(0.3, 9);
    expect(commonPhaseError(0.4, 0.1, NaN)).toBeCloseTo(0.3, 9);
    expect(commonPhaseError(0.4, 0.1, 0)).toBeCloseTo(0.3, 9);
  });

  it("result always lands in [−0.5, 0.5)", () => {
    for (const f of [0.25, 0.5, 1, 2, 4]) for (let i = 0; i < 20; i++) for (let j = 0; j < 20; j++) expect(wrap(commonPhaseError(i / 20, j / 20, f))).toBe(true);
  });
});

// serializeGrid / deserializeGrid — the analysis-cache codec. The crux: beats/phrases are
// Float32Arrays, which JSON can't round-trip natively, and a corrupt entry must NEVER yield a
// bad grid (→ null, caller re-derives).
describe("grid codec (serialize/deserialize)", () => {
  const full: Beatgrid = {
    bpm: 128.04,
    firstBeat: 0.123,
    interval: 0.46875,
    beats: new Float32Array([0.123, 0.59, 1.06, 1.53]),
    downbeat: 0,
    beatsPerBar: 4,
    phrases: new Float32Array([0.123, 30.5]),
    phraseBars: 16,
    firstSound: 0.1,
    lastSound: 200.4,
  };

  it("round-trips a full dynamic grid (Float32Arrays restored as Float32Arrays)", () => {
    const g = deserializeGrid(serializeGrid(full))!;
    expect(g.bpm).toBeCloseTo(full.bpm, 4);
    expect(g.firstBeat).toBeCloseTo(full.firstBeat, 6);
    expect(g.interval).toBeCloseTo(full.interval, 6);
    expect(g.beats).toBeInstanceOf(Float32Array);
    expect(Array.from(g.beats!)).toEqual(Array.from(full.beats!).map((x) => Math.fround(x)));
    expect(g.downbeat).toBe(0);
    expect(g.beatsPerBar).toBe(4);
    expect(g.phrases).toBeInstanceOf(Float32Array);
    expect(g.phraseBars).toBe(16);
    expect(g.firstSound).toBeCloseTo(0.1, 6);
    expect(g.lastSound).toBeCloseTo(200.4, 4);
  });

  it("round-trips a uniform grid with no beats[]/phrases (optional fields stay absent)", () => {
    const uni: Beatgrid = { bpm: 120, firstBeat: 0, interval: 0.5 };
    const g = deserializeGrid(serializeGrid(uni))!;
    expect(g.bpm).toBe(120);
    expect(g.beats).toBeUndefined();
    expect(g.phrases).toBeUndefined();
    expect(g.downbeat).toBeUndefined();
  });

  it("returns null on empty / malformed / non-grid input (caller re-derives — never a bad grid)", () => {
    expect(deserializeGrid(null)).toBeNull();
    expect(deserializeGrid(undefined)).toBeNull();
    expect(deserializeGrid("")).toBeNull();
    expect(deserializeGrid("not json{")).toBeNull();
    expect(deserializeGrid("[1,2,3]")).toBeNull(); // not an object with bpm
    // (all below also lack the epoch tag, so they'd reject on that alone — see the epoch-gate block)
    expect(deserializeGrid(JSON.stringify({ epoch: GRID_FORMAT_EPOCH, firstBeat: 0, interval: 0.5 }))).toBeNull(); // no bpm
    expect(deserializeGrid(JSON.stringify({ epoch: GRID_FORMAT_EPOCH, bpm: 0, firstBeat: 0, interval: 0.5 }))).toBeNull(); // bpm not positive
    expect(deserializeGrid(JSON.stringify({ epoch: GRID_FORMAT_EPOCH, bpm: NaN, firstBeat: 0, interval: 0.5 }))).toBeNull();
  });

  // The FORMAT-EPOCH gate: a grid must carry the exact epoch this build writes, or it's a shape we
  // can't safely parse (legacy pre-versioning, or a future/foreign detector) → null → recompute.
  it("rejects a grid whose format-epoch is missing or mismatched (shape safety)", () => {
    const body = { bpm: 120, firstBeat: 0, interval: 0.5 };
    // Structurally valid but NO epoch → a pre-versioning / foreign grid → rejected.
    expect(deserializeGrid(JSON.stringify(body))).toBeNull();
    // Wrong epoch (older or newer than this build) → rejected.
    expect(deserializeGrid(JSON.stringify({ ...body, epoch: GRID_FORMAT_EPOCH - 1 }))).toBeNull();
    expect(deserializeGrid(JSON.stringify({ ...body, epoch: GRID_FORMAT_EPOCH + 1 }))).toBeNull();
    // Exact epoch → accepted (this is what serializeGrid emits).
    expect(deserializeGrid(JSON.stringify({ ...body, epoch: GRID_FORMAT_EPOCH }))?.bpm).toBe(120);
    // And serializeGrid always embeds the current epoch, so its output survives the gate.
    expect(deserializeGrid(serializeGrid(full as Beatgrid))).not.toBeNull();
  });
});

// The cache-first REUSE path: when a persisted grid is supplied, analyzeTrack must use it verbatim
// (skip the expensive detector) while still deriving key + pyramid from the buffer.
describe("analyzeChannels with a supplied grid (cache-first reuse)", () => {
  // A short synthetic mono buffer — enough for detectKey/computePyramid to run without throwing.
  const N = 8000;
  const ch0 = new Float32Array(N);
  for (let i = 0; i < N; i++) ch0[i] = Math.sin((2 * Math.PI * 220 * i) / 16000) * 0.25;

  it("uses the supplied grid verbatim instead of detecting beats", () => {
    const supplied: Beatgrid = { bpm: 123.45, firstBeat: 0.05, interval: 60 / 123.45 };
    const a = analyzeChannels(ch0, null, 16000, supplied);
    expect(a.beatgrid).toBe(supplied); // reference-identical → detection was skipped
    expect(a.bpm).toBe(123.45); // bpm mirrors the supplied grid
    expect(a.pyramid).toBeTruthy(); // pyramid still derived locally (not persisted)
  });

  it("derives its own grid when none is supplied (no reuse)", () => {
    const supplied: Beatgrid = { bpm: 123.45, firstBeat: 0.05, interval: 60 / 123.45 };
    const withGrid = analyzeChannels(ch0, null, 16000, supplied);
    const without = analyzeChannels(ch0, null, 16000);
    expect(withGrid.beatgrid).toBe(supplied); // reused
    expect(without.beatgrid).not.toBe(supplied); // ran the detector (grid or null), never the supplied object
  });
});

// piTrim — the PI controller for the SYNC phase-lock. The headline property: on an integrator
// plant a PROPORTIONAL-only loop leaves a steady-state offset; the integral term drives it to ~0.
describe("piTrim (PI phase-lock controller)", () => {
  const CFG = { dt: 0.08, kp: 0.06, ki: 0.003, clamp: 0.02 };

  it("zero error → zero trim, integral unchanged", () => {
    const r = piTrim({ err: 0, integral: 0, ...CFG });
    expect(r.trim).toBeCloseTo(0, 10); // -(0) can be -0; functionally zero
    expect(r.integral).toBeCloseTo(0, 10);
  });

  it("ahead of the master (err>0) trims SLOWER (negative); behind trims faster", () => {
    expect(piTrim({ err: 0.1, integral: 0, ...CFG }).trim).toBeLessThan(0);
    expect(piTrim({ err: -0.1, integral: 0, ...CFG }).trim).toBeGreaterThan(0);
  });

  it("the integral accumulates a constant error over ticks (so trim grows toward the offset)", () => {
    let I = 0;
    for (let i = 0; i < 50; i++) I = piTrim({ err: 0.05, integral: I, ...CFG }).integral;
    expect(I).toBeGreaterThan(0); // built up from the steady positive error
  });

  // Closed-loop simulation: plant is dε/dt = Δf + g·trim (rate→phase integrator) with a constant
  // base-tempo mismatch Δf (the disturbance that leaves the residual). P-only parks at an offset;
  // PI drives it to ~0.
  function sim(ki: number, steps: number): number {
    const g = 1.8; // trim → phase-frequency gain (~bpm/60)
    const df = 0.005; // constant base-tempo mismatch (the disturbance)
    let e = 0;
    let I = 0;
    for (let n = 0; n < steps; n++) {
      const r = piTrim({ err: e, integral: I, dt: CFG.dt, kp: CFG.kp, ki, clamp: CFG.clamp });
      I = r.integral;
      e = e + (df + g * r.trim) * CFG.dt; // integrate the plant
    }
    return e;
  }

  it("P-only (ki=0) parks at a NON-zero steady-state offset", () => {
    const e = sim(0, 3000);
    expect(Math.abs(e)).toBeGreaterThan(0.02); // a real residual (≈ df/(g·kp))
  });

  it("PI (ki>0) drives the steady-state offset to ~zero", () => {
    const e = sim(CFG.ki, 3000);
    expect(Math.abs(e)).toBeLessThan(0.005); // the integral cancels the disturbance
  });

  it("anti-windup: a saturating error can't wind the integral past its limit, output stays clamped", () => {
    let I = 0;
    let last = { trim: 0, integral: 0, raw: 0 };
    for (let i = 0; i < 2000; i++) {
      last = piTrim({ err: 0.45, integral: I, ...CFG }); // huge sustained error → saturates
      I = last.integral;
    }
    expect(Math.abs(last.trim)).toBeLessThanOrEqual(CFG.clamp + 1e-9); // output clamped
    expect(Math.abs(I)).toBeLessThanOrEqual(CFG.clamp / CFG.ki + 1e-6); // integral bounded (no windup)
  });

  it("raw exposes the pre-clamp output so the diagnostic can flag saturation", () => {
    const r = piTrim({ err: 0.5, integral: 0, ...CFG });
    expect(Math.abs(r.raw)).toBeGreaterThan(Math.abs(r.trim)); // raw > clamped → saturated
  });
});
