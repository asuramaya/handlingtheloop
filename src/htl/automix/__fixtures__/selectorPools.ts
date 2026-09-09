// Read the captured pools back in the shape the selector actually sees.
//
// The rows come off production (scripts/capture-selector-fixture.mjs); this file does the two
// things the CLIENT does to them, and nothing else:
//   • rel from RANK — `(1 - i/len) * weight`, the same expression as queue.ts:357. It is derived,
//     not stored, so the fixture cannot hold a stale second copy of the formula.
//   • analysis merged onto the track — the same merge as enrichPool, so an unanalysed candidate
//     arrives with bpm/key/energy genuinely absent rather than zeroed.
//
// Each captured pool is ONE seed at full weight, which is the `current` seed's own list (radioSeeds
// gives the playing track weight 1). A real fill merges two or three such lists; this is the
// single-seed case, and every claim made off it should be read that way.
//
// The JSON is read from DISK rather than imported, deliberately: an `import ... from "*.json"`
// would need resolveJsonModule across the whole project and would make the fixture reachable from
// app code, where a 200-row capture has no business being. readFileSync cannot resolve in a
// browser bundle, so this module is structurally test-only.
import { readFileSync } from "node:fs";
import type { Candidate } from "../selector";
import type { TrackMeta } from "../../library/types";

export interface CapturedPool {
  seed: TrackMeta;
  candidates: Candidate[];
}

interface RawRow { videoId: string; title: string; artist: string; duration: number }
interface RawFixture {
  capturedAt: string;
  origin: string;
  // `candidates` counts OCCURRENCES (a track in two pools is scored twice, so this is the
  // denominator a pick faces); `distinct` counts unique tracks (the denominator for coverage).
  // They differ because radio lists overlap — see the capture script's own note.
  census: {
    seeds: number;
    candidates: number;
    distinct: number;
    analysed: number;
    withBpm: number;
    withKey: number;
    withEnergy: number;
    analysedOccurrences: number;
    energyOccurrences: number;
  };
  pools: { seed: RawRow; candidates: RawRow[] }[];
  analysis: Record<string, { bpm: number | null; key: string | null; energy: number | null } | undefined>;
}

const raw = JSON.parse(readFileSync(new URL("./selectorPools.json", import.meta.url), "utf8")) as RawFixture;
export const census = raw.census;
export const capturedAt = raw.capturedAt;

function meta(r: RawRow): TrackMeta {
  const a = raw.analysis[r.videoId];
  return {
    videoId: r.videoId,
    title: r.title,
    artist: r.artist,
    duration: r.duration,
    thumbnail: null,
    views: null,
    // Absent, not zero. A candidate prod knows nothing about must reach scoreCandidate as unknown,
    // because "unknown" and "0 BPM" score differently on purpose (selector.ts's header).
    ...(a?.bpm != null ? { bpm: a.bpm } : {}),
    ...(a?.key != null ? { key: a.key } : {}),
    ...(a?.energy != null ? { energy: a.energy } : {}),
  };
}

/** The captured pools, as the selector would receive them. `at` is a synthetic arrival order —
 *  the capture has no timestamps, and `at` only ever breaks exact ties. */
export function pools(weight = 1): CapturedPool[] {
  return raw.pools.map((p) => ({
    seed: meta(p.seed),
    candidates: p.candidates.map((c, i) => ({
      track: meta(c),
      rel: (1 - i / Math.max(1, p.candidates.length)) * weight,
      from: p.seed.videoId,
      at: i,
    })),
  }));
}

/** Every captured candidate, flattened — for questions about the population rather than a pick. */
export function allCandidates(): Candidate[] {
  return pools().flatMap((p) => p.candidates);
}
