import { describe, test, expect } from "vitest";
import { d1EnrichTargets, isrcEnrichTargets } from "./poolEnrich";
import type { TrackMeta } from "../library/types";

const t = (i: number, over: Partial<TrackMeta> = {}): { track: TrackMeta } => ({
  track: { videoId: `v${String(i).padStart(10, "0")}`, title: "", artist: "", duration: 0, thumbnail: null, views: null, ...over },
});

describe("d1EnrichTargets", () => {
  test("asks for EVERY un-analysed candidate in a full pool, not the first slice", () => {
    const pool = Array.from({ length: 60 }, (_, i) => t(i));
    expect(d1EnrichTargets(pool)).toHaveLength(60);
  });

  test("a fully analysed candidate is not asked; one missing only energy is", () => {
    const pool = [t(1, { bpm: 120, key: "8A", energy: 0.4 }), t(2, { bpm: 120, key: "8A" })];
    expect(d1EnrichTargets(pool)).toEqual([pool[1].track.videoId]);
  });

  test("an id the endpoint would reject is not asked", () => {
    expect(d1EnrichTargets([t(1, { videoId: "local:file.mp3" })])).toEqual([]);
  });
});

describe("isrcEnrichTargets", () => {
  test("tried candidates are skipped, so later ones get their turn", () => {
    const pool = Array.from({ length: 6 }, (_, i) => t(i, { isrc: `ISRC${i}` }));
    const tried = new Set(pool.slice(0, 4).map((c) => c.track.videoId));
    expect(isrcEnrichTargets(pool, tried, 4).map((c) => c.track.videoId)).toEqual([pool[4].track.videoId, pool[5].track.videoId]);
  });

  test("capped at n, and only candidates carrying an ISRC and missing bpm or key", () => {
    const pool = [t(1), t(2, { isrc: "X", bpm: 100, key: "1A" }), ...Array.from({ length: 5 }, (_, i) => t(10 + i, { isrc: `I${i}` }))];
    expect(isrcEnrichTargets(pool, new Set(), 4)).toHaveLength(4);
    expect(isrcEnrichTargets(pool, new Set(), 4).every((c) => !!c.track.isrc && c.track.bpm == null)).toBe(true);
  });
});
