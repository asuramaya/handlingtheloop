import { describe, expect, it, test } from "vitest";
import type { TrackMeta } from "../library/types";
import type { StyleCapabilities, TransitionPlan } from "./types";
import {
  avgMixability,
  bpmRatioFolded,
  camelotDistance,
  mixability,
  pickTransition,
  planTier,
  rankByMixability,
  smartSortChain,
  songCore,
  transitionLabel,
  resolveStyle,
} from "./mixability";

function track(p: Partial<TrackMeta>): TrackMeta {
  return { videoId: "x".repeat(11), title: "", artist: "", duration: 0, thumbnail: null, views: null, ...p };
}

describe("camelotDistance", () => {
  it("is 0 for the same key, 1 for a fifth or relative, higher for clashes", () => {
    expect(camelotDistance("8A", "8A")).toBe(0);
    expect(camelotDistance("8A", "9A")).toBe(1); // adjacent on the ring (fifth)
    expect(camelotDistance("8A", "8B")).toBe(1); // relative major/minor
    expect(camelotDistance("8A", "2A")).toBeGreaterThanOrEqual(2); // across the wheel
  });
  it("wraps around 12↔1 and returns null when unknown", () => {
    expect(camelotDistance("12A", "1A")).toBe(1);
    expect(camelotDistance("8A", null)).toBeNull();
    expect(camelotDistance(undefined, "8A")).toBeNull();
  });
});

describe("bpmRatioFolded", () => {
  it("folds double/half tempo to ~1", () => {
    expect(bpmRatioFolded(128, 128)).toBeCloseTo(1, 5);
    expect(bpmRatioFolded(128, 64)).toBeCloseTo(1, 5); // half-time mixes fine
    expect(bpmRatioFolded(70, 140)).toBeCloseTo(1, 5); // double-time
  });
});

describe("mixability + pickTransition", () => {
  const seed = track({ key: "8A", bpm: 128 });
  const harmonic = track({ videoId: "a".repeat(11), key: "9A", bpm: 128 }); // fifth, same BPM
  const clash = track({ videoId: "b".repeat(11), key: "3B", bpm: 100 }); // far key + tempo gap

  it("scores a harmonic, tempo-matched pair above a clashing one", () => {
    expect(mixability(seed, harmonic).score).toBeGreaterThan(mixability(seed, clash).score);
  });

  it("ranks the harmonic neighbour first", () => {
    const ranked = rankByMixability(seed, [clash, harmonic]);
    expect(ranked[0]).toBe(harmonic);
  });

  it("picks a long harmonic blend for compatible pairs and a quick cut for clashes", () => {
    expect(pickTransition(seed, harmonic).style).toBe("blend");
    expect(pickTransition(seed, harmonic).bars).toBeGreaterThanOrEqual(12);
    expect(pickTransition(seed, clash).style).toBe("cut");
  });
});

describe("honesty when unanalysed", () => {
  const a = track({ videoId: "a".repeat(11) }); // no key/bpm
  const b = track({ videoId: "b".repeat(11) });

  it("does not claim 'Harmonic' for a pair with no key data", () => {
    const plan = pickTransition(a, b);
    expect(plan.confident).toBe(false);
    expect(plan.keyKnown).toBe(false);
    expect(transitionLabel(plan)).not.toContain("Harmonic");
    expect(transitionLabel(plan)).toContain("?");
    expect(planTier(plan)).toBe("unknown");
  });

  it("uses a real harmonic label once both keys are known + compatible", () => {
    const x = track({ videoId: "x".repeat(11), key: "8A", bpm: 128 });
    const y = track({ videoId: "y".repeat(11), key: "9A", bpm: 128 });
    expect(transitionLabel(pickTransition(x, y))).toContain("Harmonic");
  });
});

describe("avgMixability (both-deck fit)", () => {
  it("rewards a candidate that fits both seeds over one that fits neither", () => {
    const seedA = track({ videoId: "1".repeat(11), key: "8A", bpm: 128 });
    const seedB = track({ videoId: "2".repeat(11), key: "9A", bpm: 128 });
    const fits = track({ videoId: "3".repeat(11), key: "8A", bpm: 128 });
    const clashes = track({ videoId: "4".repeat(11), key: "3B", bpm: 96 });
    expect(avgMixability([seedA, seedB], fits)).toBeGreaterThan(avgMixability([seedA, seedB], clashes));
  });
});

describe("songCore (song-level dedup)", () => {
  it("collapses versions / remixes / mashups of the same song", () => {
    const base = songCore("Danza Kuduro");
    expect(base).toBe("danza kuduro");
    expect(songCore("Danza Kuduro (Original Mix)")).toBe(base);
    expect(songCore("Danza kuduro x Pepas")).toBe(base);
    expect(songCore("Danza Kuduro (Official Video) ft. Lucenzo")).toBe(base);
  });
  it("keeps genuinely different songs distinct", () => {
    expect(songCore("Vem Dancar Kuduro")).not.toBe(songCore("Danza Kuduro"));
    expect(songCore("Vamos a la Playa")).not.toBe(songCore("Danza Kuduro"));
  });
});

describe("smartSortChain", () => {
  it("keeps the anchor and orders by flow", () => {
    const a = track({ videoId: "a".repeat(11), key: "8A", bpm: 128 });
    const b = track({ videoId: "b".repeat(11), key: "9A", bpm: 128 }); // mixes well after a
    const c = track({ videoId: "c".repeat(11), key: "3B", bpm: 100 }); // clashes with a
    const sorted = smartSortChain([a, c, b]);
    expect(sorted[0]).toBe(a); // anchor preserved
    expect(sorted[1]).toBe(b); // best follow-on next
    expect(sorted).toHaveLength(3);
  });
});

// ── the transition vocabulary ───────────────────────────────────────────────────────────────────
// resolveStyle is where "AUTO has one gesture" got fixed. Three properties matter: it never picks
// something the decks cannot do, it stays musically appropriate, and it declines to repeat itself
// when — and only when — it has a genuinely comparable alternative.
describe("resolveStyle", () => {
  const plan = (score: number, confident = true): TransitionPlan => ({
    style: "blend",
    bars: 16,
    bassSwapBar: 6,
    keyMatch: true,
    score,
    keyKnown: true,
    confident,
  });
  const caps = (over: Partial<StyleCapabilities> = {}): StyleCapabilities => ({
    stems: false,
    fx: true, // the pad-FX bank is permanently resident on every deck
    incomingBody: false,
    grid: true,
    ...over,
  });

  test("a well-matched pair with stems available gets the stem swap", () => {
    expect(resolveStyle(plan(0.9), caps({ stems: true }), null)).toBe("stemswap");
  });

  test("the same pair WITHOUT stems falls to a blend, not to nothing", () => {
    expect(resolveStyle(plan(0.9), caps(), null)).toBe("blend");
  });

  test("an unproven pair is masked rather than committed to", () => {
    expect(resolveStyle(plan(0.5, false), caps(), null)).toBe("filter");
  });

  test("a clashing pair gets a deliberate change, never a blend", () => {
    const style = resolveStyle(plan(0.2), caps({ incomingBody: true }), null);
    expect(["gateChop", "loopChop", "dropSwap", "spinOut", "cut"]).toContain(style);
    expect(["blend", "stemswap"]).not.toContain(style); // the point: a clash is never blended
  });

  // Availability gates, one per capability.
  // ★ Stems are OPTIONAL, so the gestures that carry the character must not need them. Only
  // stemswap does; everything else runs off the channel FX and the loop engine.
  test("a deck with no stems still gets an effect-driven gesture, not a bare blend", () => {
    for (const score of [0.2, 0.45, 0.6, 0.9]) {
      const style = resolveStyle(plan(score), caps({ stems: false }), "blend");
      expect(style).not.toBe("stemswap");
      expect(["echoOut", "washOut", "gateChop", "loopChop", "filter", "dropSwap", "spinOut", "cut"]).toContain(style);
    }
  });

  test("echoOut and washOut need the FX rack; without it they are off the table", () => {
    const style = resolveStyle(plan(0.6), caps({ fx: false }), null);
    expect(["echoOut", "washOut", "gateChop"]).not.toContain(style);
  });

  test("loopChop needs only a grid — no FX device, no stems", () => {
    expect(resolveStyle(plan(0.45), caps({ fx: false, grid: true }), "filter")).toBe("loopChop");
  });

  test("gateChop needs the grid too — a gate off the beat is noise", () => {
    expect(resolveStyle(plan(0.2), caps({ grid: false }), null)).toBe("cut");
  });

  test("dropSwap requires a detected body section on the incoming", () => {
    expect(resolveStyle(plan(0.2), caps({ incomingBody: false }), null)).not.toBe("dropSwap");
  });

  test("without a beatgrid the rhythmic gestures are off the table", () => {
    const style = resolveStyle(plan(0.2), caps({ grid: false, incomingBody: true }), null);
    expect(style).toBe("cut");
  });

  // The anti-repetition rule, and its limit.
  test("does not repeat the last gesture when a comparable alternative exists", () => {
    expect(resolveStyle(plan(0.9), caps({ stems: true }), "stemswap")).toBe("blend");
  });

  test("but DOES repeat rather than pick something clearly worse", () => {
    // A clashing pair with no grid and no FX has exactly one legal option; variety must not
    // invent one.
    expect(resolveStyle(plan(0.2), caps({ grid: false, fx: false }), "cut")).toBe("cut");
  });

  test("always returns a style that is actually available", () => {
    for (const score of [0.1, 0.3, 0.5, 0.7, 0.95]) {
      for (const c of [caps(), caps({ stems: true }), caps({ fx: false }), caps({ incomingBody: true }), caps({ grid: false })]) {
        for (const last of [null, "blend", "cut", "stemswap"] as const) {
          const style = resolveStyle(plan(score), c, last);
          if (style === "stemswap") expect(c.stems).toBe(true);
          if (style === "echoOut" || style === "washOut") expect(c.fx).toBe(true);
          if (style === "gateChop") expect(c.fx && c.grid).toBe(true);
          if (style === "loopChop") expect(c.grid).toBe(true);
          if (style === "dropSwap") expect(c.incomingBody && c.grid).toBe(true);
          if (style === "spinOut") expect(c.grid).toBe(true);
        }
      }
    }
  });
});

// ★ Regression: the seed track coming straight back. Observed live — the radio followed
// "Teardrop (Remastered 2019)" with "Massive Attack - Teardrop (Live in Berlin)" because the two
// titles produced different songCore keys. YouTube is wildly inconsistent about the "Artist - "
// prefix, so the dedup has to see through it.
describe("songCore — the artist-prefix gap", () => {
  it("collapses a prefixed and an unprefixed upload of the same song", () => {
    expect(songCore("Massive Attack - Teardrop (Live in Berlin)")).toBe(songCore("Teardrop (Remastered 2019)"));
  });

  it("still collapses the version markers it always did", () => {
    const core = songCore("Danza Kuduro");
    expect(songCore("Danza Kuduro (Original Mix)")).toBe(core);
    expect(songCore("Don Omar - Danza Kuduro (Official Video)")).toBe(core);
  });

  it("keeps genuinely different songs by the same artist apart", () => {
    expect(songCore("Massive Attack - Teardrop")).not.toBe(songCore("Massive Attack - Angel"));
  });

  it("does not eat a title that merely contains a dash mid-phrase", () => {
    expect(songCore("Sunset")).toBe(songCore("Sunset"));
    expect(songCore("Nine Inch Nails - Closer")).toBe("closer");
  });

  it("leaves a title with no prefix alone", () => {
    expect(songCore("Archangel")).toBe("archangel");
  });
});
