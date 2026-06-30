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
  nearestBeat,
  beatTimeOffset,
  barAnchor,
  barPhase,
  foldTempoOctave,
  commonPhaseError,
  type KeyInfo,
  type Beatgrid,
} from "./analyze";

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
