import { describe, test, expect } from "vitest";
// autoMixer.ts imports cleanly in a plain-node test env (no AudioContext/DOM is
// touched at module load — the engine is only reached through the injected deps),
// so its pure module-level helpers can be unit-tested directly.
import { barsToSeconds, decideLive, entryRamp, gainTrim, other } from "./autoMixer";


describe("gainTrim — AUTO's channel gain staging", () => {
  const db = (g: number) => 20 * Math.log10(g);

  test("a track already at the reference level is left alone", () => {
    expect(gainTrim(0.14)).toBeCloseTo(1, 6);
  });

  test("a quiet master is pushed UP toward the reference", () => {
    const g = gainTrim(0.07); // half the reference RMS → +6 dB wanted
    expect(g).toBeGreaterThan(1);
    expect(db(g)).toBeCloseTo(6, 1);
  });

  test("a loud master is pulled DOWN toward the reference", () => {
    const g = gainTrim(0.28); // double the reference → −6 dB wanted
    expect(g).toBeLessThan(1);
    expect(db(g)).toBeCloseTo(-6, 1);
  });

  // The clamp is what keeps a pathological track (a near-silent rip, a brickwalled master)
  // from being shoved 20 dB and blowing up the mix.
  test("boost is clamped at +6 dB however quiet the track is", () => {
    expect(db(gainTrim(0.0001))).toBeCloseTo(6, 6);
  });

  test("cut is clamped at −6 dB however loud the track is", () => {
    expect(db(gainTrim(0.9))).toBeCloseTo(-6, 6);
  });

  // Deck.loudness reports 0 for both "no buffer yet" and "pure silence"; dividing by it would
  // be an infinite boost, so both must fall through to unity and be retried later.
  test("loudness 0 (no buffer / silence) → unity, never an infinite boost", () => {
    expect(gainTrim(0)).toBe(1);
    expect(gainTrim(-1)).toBe(1);
    expect(gainTrim(NaN)).toBe(1);
  });
});

describe("barsToSeconds", () => {
  // 4 bars * 4 beats/bar * 60s / bpm. At 120bpm: 16 beats * 0.5s = 8s.
  test("4 bars @ 120bpm = 8s", () => {
    expect(barsToSeconds(4, 120)).toBeCloseTo(8, 10);
  });

  test("12 bars @ 120bpm = 24s (the armed-phase default lead window)", () => {
    expect(barsToSeconds(12, 120)).toBeCloseTo(24, 10);
  });

  test("1 bar @ 60bpm = 4s (one beat per second, 4 beats)", () => {
    expect(barsToSeconds(1, 60)).toBeCloseTo(4, 10);
  });

  test("scales inversely with bpm: doubling bpm halves the seconds", () => {
    expect(barsToSeconds(8, 174)).toBeCloseTo(barsToSeconds(8, 87) / 2, 10);
  });

  // Invalid/zero/negative bpm → fallback of `bars * 2` seconds (a neutral 120bpm-ish
  // guess so the mixer never divides by zero or produces NaN/Infinity).
  test("bpm = 0 → fallback bars*2", () => {
    expect(barsToSeconds(4, 0)).toBe(8);
  });

  test("negative bpm → fallback bars*2", () => {
    expect(barsToSeconds(6, -120)).toBe(12);
  });

  test("NaN bpm → fallback bars*2 (NaN is falsy under the `!bpm` guard? no — guard uses bpm<=0)", () => {
    // NOTE: the guard is `if (!bpm || bpm <= 0)`. NaN is truthy-falsy: `!NaN === true`,
    // so NaN hits the fallback branch and returns bars*2. Documented, not a bug.
    expect(barsToSeconds(3, NaN)).toBe(6);
  });
});

describe("other", () => {
  test("A → B", () => {
    expect(other("A")).toBe("B");
  });

  test("B → A", () => {
    expect(other("B")).toBe("A");
  });

  test("is an involution: other(other(x)) === x", () => {
    expect(other(other("A"))).toBe("A");
    expect(other(other("B"))).toBe("B");
  });
});

// The fedBack spiral guard (radioSeedSet) that used to live here is gone with the function — see
// the note in autoMixer.ts. Its replacement, the anchor/current seeding model, is tested in
// selector.test.ts, where the logic now lives.

// The stale-liveId stall: "deck B plays but it thinks A is live, stalls till A ends". decideLive
// must ALWAYS resolve to a deck the user is actually hearing, and when the user starts a second
// deck under the mixer it must FOLLOW the just-started one — not cling to the old liveId.
describe("decideLive — which deck is the user actually hearing", () => {
  test("nothing playing → null (caller decides end-vs-pause)", () => {
    expect(decideLive({ aPlay: false, bPlay: false, aPlayPrev: false, bPlayPrev: false, liveId: "A" })).toBeNull();
  });

  test("only A playing → A", () => {
    expect(decideLive({ aPlay: true, bPlay: false, aPlayPrev: true, bPlayPrev: false, liveId: "A" })).toBe("A");
  });

  test("only B playing → B (even when liveId still says A — the stall bug's recovery)", () => {
    expect(decideLive({ aPlay: false, bPlay: true, aPlayPrev: false, bPlayPrev: true, liveId: "A" })).toBe("B");
  });

  test("THE FIX: armed on A, user starts B → both play, B just rose → follow B", () => {
    // Previous tick only A played; now both play because the user dropped a track on B.
    expect(decideLive({ aPlay: true, bPlay: true, aPlayPrev: true, bPlayPrev: false, liveId: "A" })).toBe("B");
  });

  test("symmetric: live on B, user starts A → follow A", () => {
    expect(decideLive({ aPlay: true, bPlay: true, aPlayPrev: false, bPlayPrev: true, liveId: "B" })).toBe("A");
  });

  test("steady manual blend (both already playing, no new start) → keep the live deck", () => {
    expect(decideLive({ aPlay: true, bPlay: true, aPlayPrev: true, bPlayPrev: true, liveId: "B" })).toBe("B");
    expect(decideLive({ aPlay: true, bPlay: true, aPlayPrev: true, bPlayPrev: true, liveId: "A" })).toBe("A");
  });

  test("both rose together (rare) → keep live if valid, else default A", () => {
    expect(decideLive({ aPlay: true, bPlay: true, aPlayPrev: false, bPlayPrev: false, liveId: "B" })).toBe("B");
    expect(decideLive({ aPlay: true, bPlay: true, aPlayPrev: false, bPlayPrev: false, liveId: null })).toBe("A");
  });

  test("result is always a deck that is actually playing", () => {
    // Property: for every combination where something plays, the chosen deck is one that plays.
    for (const aPlay of [true, false]) {
      for (const bPlay of [true, false]) {
        if (!aPlay && !bPlay) continue;
        for (const aPlayPrev of [true, false]) {
          for (const bPlayPrev of [true, false]) {
            for (const liveId of ["A", "B", null] as const) {
              const r = decideLive({ aPlay, bPlay, aPlayPrev, bPlayPrev, liveId });
              expect(r === "A" ? aPlay : bPlay).toBe(true);
            }
          }
        }
      }
    }
  });
});

// ── the incoming half of a transition ──────────────────────────────────────────────────────────
// These numbers used to live inside the style branches of tickMixing, where nothing could see
// them: the machine tests' FakeDeck has always had no-op setEqLow/setFilter. Splitting the
// incoming gesture out of the outgoing one is only safe if the extracted ramps are still the ramps
// each style actually had — so the first block is a GOLDEN test against the pre-refactor formulas,
// written out longhand rather than referencing the implementation.
describe("entryRamp — how the incoming track arrives", () => {
  const EQ_KILL = -26;
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

  test("`open` writes no filter and opens the low — what most gestures always did", () => {
    for (const p of [0, 0.3, 0.7, 1]) {
      expect(entryRamp("open", p, p)).toEqual({ filter: null, eqLow: 0 });
    }
  });

  test("`sweep` matches the blend's historical incoming ramp exactly", () => {
    for (const p of [0, 0.25, 0.5, 0.75, 1]) {
      const s = clamp(p * 1.3, 0, 1); // any s — the eqLow term is a function of s alone
      expect(entryRamp("sweep", p, s)).toEqual({
        filter: lerp(-0.55, 0, clamp(p / 0.5, 0, 1)),
        eqLow: lerp(EQ_KILL, 0, s),
      });
    }
  });

  test("`sweepWide` matches the filter style's historical incoming ramp exactly", () => {
    for (const p of [0, 0.25, 0.5, 0.75, 1]) {
      const s = clamp(p * 1.3, 0, 1);
      expect(entryRamp("sweepWide", p, s)).toEqual({ filter: lerp(-0.85, 0, p), eqLow: lerp(EQ_KILL, 0, s) });
    }
  });

  test("`underLoop` matches the loop chop's historical incoming ramp exactly", () => {
    for (const p of [0, 0.25, 0.5, 0.75, 1]) {
      expect(entryRamp("underLoop", p, 0.5)).toEqual({
        filter: lerp(-0.5, 0, clamp(p / 0.6, 0, 1)),
        eqLow: 0, // the loop chop kills the OUTGOING low separately — nothing to swap with
      });
    }
  });

  // ── the two that were previously unreachable ──
  test("`dropIn` holds the incoming back, then lands it", () => {
    // Held: no creep open, so the ear stops expecting it.
    const early = entryRamp("dropIn", 0.2, 0.5);
    const late = entryRamp("dropIn", 0.75, 0.9);
    expect(early).toEqual(late); // flat across the whole hold — that IS the gesture
    expect(early.filter).toBeLessThan(-0.5);
    expect(early.eqLow).toBe(EQ_KILL);
    // Then released over the last fifth, arriving fully open exactly at the end.
    expect(entryRamp("dropIn", 0.9, 1).filter).toBeCloseTo(-0.4, 6);
    const landed = entryRamp("dropIn", 1, 1);
    expect(landed.filter).toBeCloseTo(0, 9);
    expect(landed.eqLow).toBeCloseTo(0, 9);
  });

  test("`riseIn` swells the whole way with the low end arriving late", () => {
    // Filter climbs from the very start…
    expect(entryRamp("riseIn", 0, 0).filter).toBeCloseTo(-0.9, 6);
    expect(entryRamp("riseIn", 0.5, 0).filter).toBeCloseTo(-0.45, 6);
    expect(entryRamp("riseIn", 1, 0).filter).toBe(0);
    // …but the bass is still killed at the midpoint, and only then starts to come.
    expect(entryRamp("riseIn", 0.4, 0).eqLow).toBe(EQ_KILL);
    expect(entryRamp("riseIn", 0.75, 0).eqLow).toBeGreaterThan(EQ_KILL);
    expect(entryRamp("riseIn", 1, 0).eqLow).toBe(0);
  });

  // ★ The invariant every entry shares: by the end of the transition the incoming deck must be
  // completely unshaped, or settle inherits a filtered, bass-cut deck as the new live one.
  test("EVERY entry finishes fully open — settle must never inherit a shaped deck", () => {
    for (const e of ["open", "sweep", "sweepWide", "underLoop", "dropIn", "riseIn"] as const) {
      const end = entryRamp(e, 1, 1);
      // toBeCloseTo, not toBe: lerp(EQ_KILL, 0, 1) lands a few times 1e-15 off zero. That is
      // inaudible (and the deck clamps anyway); what matters is that nothing is left SHAPED.
      expect(end.eqLow).toBeCloseTo(0, 9);
      if (end.filter != null) expect(end.filter).toBeCloseTo(0, 9);
    }
  });

  test("no entry ever pushes the low ABOVE unity or the filter past its rails", () => {
    for (const e of ["open", "sweep", "sweepWide", "underLoop", "dropIn", "riseIn"] as const) {
      for (let i = 0; i <= 20; i++) {
        const p = i / 20;
        const r = entryRamp(e, p, p);
        expect(r.eqLow).toBeLessThanOrEqual(1e-9);
        expect(r.eqLow).toBeGreaterThanOrEqual(EQ_KILL);
        if (r.filter != null) {
          expect(r.filter).toBeLessThanOrEqual(0);
          expect(r.filter).toBeGreaterThanOrEqual(-1);
        }
      }
    }
  });
});
