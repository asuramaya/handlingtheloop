import { describe, expect, it } from "vitest";
import type { TrackMeta } from "../library/types";
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
