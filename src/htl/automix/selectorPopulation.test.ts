import { describe, expect, it } from "vitest";
import { pools, allCandidates, census, capturedAt } from "./__fixtures__/selectorPools";
import { pickBest, scoreCandidate, type Candidate } from "./selector";
import type { TrackMeta } from "../library/types";

// WHAT THE SELECTOR ACTUALLY SEES.
//
// Thread 0ff6100c: the scoring weights were set by reasoning, and no dev run can check them —
// plain `vite` has no D1, so every candidate scores analysed:0 and the terms that depend on
// analysis are constant across the pool. Operator's ruling: capture prod-shaped rows and hold
// them locally as a fixture, "not even a sim though its just prod shape locally".
//
// So these are REAL rows: eight real seeds, their real /api/recommend pools in provider order,
// and prod's real answer for which of those it has analysis for. Nothing here is invented.
//
// ★ THE HEADLINE, AND IT IS NOT WHAT THE WEIGHTS ASSUME: 11 of 228 distinct captured candidates
// carry any analysis at all, and 2 of 228 carry energy — 13 and 4 of the 240 scored OCCURRENCES.
// A second, disjoint capture (8 different seeds, 216 candidates) agreed: 9 analysed, 2 with
// energy. So this is the population, not a bad draw. Two of the eight pools had ZERO analysed
// candidates, so it is not one lucky pool carrying the rate either.
//
// These tests are CHARACTERISATION, not aspiration. They say what the shipped weights do over the
// real population, so that changing a weight has a visible consequence instead of a private
// opinion. A failure here means the population moved or a weight did — both worth looking at, and
// neither automatically a bug.

const opts = (nearby: readonly TrackMeta[] = [], target = 0.5) => ({ nearby, playedRecently: [] as string[], target });
const analysed = (c: Candidate) => c.track.bpm != null || c.track.key != null;

describe("the captured population", () => {
  it("matches the census the capture wrote beside it", () => {
    // The fixture carries its own census so a reader can never quote a number from it without
    // seeing which rows produced that number. This is the check that the two still agree.
    const all = allCandidates();
    expect(all).toHaveLength(census.candidates);
    expect(pools()).toHaveLength(census.seeds);
    // Counted over OCCURRENCES, because that is what `all` is — the flattened pools, a track once
    // per pool it appears in. The census's `analysed`/`withEnergy` are over DISTINCT tracks and are
    // deliberately different numbers; conflating the two is how a coverage rate gets quoted wrong.
    expect(all.filter(analysed)).toHaveLength(census.analysedOccurrences);
    expect(all.filter((c) => c.track.energy != null)).toHaveLength(census.energyOccurrences);
    expect(census.distinct).toBeLessThanOrEqual(census.candidates);
    expect(capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("is overwhelmingly UNANALYSED — the fact the weights were not set against", () => {
    const all = allCandidates();
    const rate = all.filter(analysed).length / all.length;
    // Deliberately a loose bound around a measured ~5%. The point is the ORDER OF MAGNITUDE: any
    // reasoning that assumed analysis is the common case is reasoning about a different pool.
    expect(rate).toBeLessThan(0.15);
    expect(all.filter((c) => c.track.energy != null).length / all.length).toBeLessThan(0.05);
  });
});

describe("what the weights do over that population", () => {
  it("energy is inert: dropping the whole energy term changes no pick", () => {
    // energyFit reports `known: false` for a candidate with no energy, and the term contributes 0.
    // With 2 of 228 carrying energy, W_ENERGY (0.12 — an eighth of the weight budget) cannot move
    // a ranking in practice. This test is the receipt for that claim, and it is the one to watch:
    // the day analysis coverage rises, it should start failing.
    for (const p of pools()) {
      const withEnergy = pickBest(p.candidates, p.seed, opts())!;
      const withoutEnergy = pickBest(
        p.candidates.map((c) => ({ ...c, track: { ...c.track, energy: null } })),
        p.seed,
        opts(),
      )!;
      expect(withoutEnergy.candidate.track.videoId).toBe(withEnergy.candidate.track.videoId);
    }
  });

  it("relatedness decides: the pick is the provider's own top eligible candidate", () => {
    // With key/bpm/energy unknown for ~95% of the pool and no artist repetition inside a single
    // radio list, the score collapses to W_REL * rel — which is monotonic in provider rank. So the
    // selector currently RATIFIES provider order rather than re-ranking it. That is the honest
    // description of today's behaviour, and the baseline any weight change has to beat.
    for (const p of pools()) {
      const best = pickBest(p.candidates, p.seed, opts())!;
      const parts = scoreCandidate(best.candidate, p.seed, opts());
      expect(parts.rel).toBeGreaterThan(0);
      // rel is the largest single positive term for the winner, in every captured pool.
      expect(parts.rel).toBeGreaterThanOrEqual(Math.max(parts.key, parts.bpm, parts.energy, parts.analysed));
    }
  });

  it("analysis OUTRANKS the whole provider spread when it is present — which it almost never is", () => {
    // I expected the opposite and the real rows said otherwise, so this is worth stating plainly.
    // The comparison is between exactly two real candidates, so nothing else in the pool can carry
    // the result: the provider's TOP pick knowing nothing, against its BOTTOM pick agreeing
    // perfectly on key, tempo and energy.
    //
    // Measured on the captured pool: blind top = 0.42 (all rel), perfect bottom = 0.534
    // (0.014 rel + 0.16 key + 0.18 bpm + 0.12 energy + 0.06 analysed). The bottom one WINS by
    // 0.114, because what full agreement is worth (0.52) is larger than the entire rel spread of a
    // 30-deep list (0.42 → 0.014, a range of 0.406).
    //
    // ★ SO THE MECHANISM IS NOT TOO TIMID — it is decisive enough to overturn the provider's whole
    // ranking. It is just IDLE, on ~95% of real candidates. That reframes the tuning question this
    // fixture exists to answer: the lever worth pulling is COVERAGE, not the weights, and raising a
    // weight to compensate would only sharpen a knife that is already sharp and rarely drawn.
    const p = pools()[0];
    const seed: TrackMeta = { ...p.seed, bpm: 128, key: "8A", energy: 0.5 };
    const top = p.candidates[0];
    const last = p.candidates[p.candidates.length - 1];
    const blindTop = { ...top, track: { ...top.track, bpm: null, key: null, energy: null } };
    const perfectLast = { ...last, track: { ...last.track, bpm: 128, key: "8A", energy: 0.5 } };
    const best = pickBest([blindTop, perfectLast], seed, opts())!;
    expect(best.candidate.track.videoId).toBe(last.track.videoId);
    // The margin, in the fixture's own units — this is the tuning dial made visible. A band, not
    // an exact float, because the claim is about the BALANCE between the two halves of the score;
    // any weight change large enough to matter moves it out of this range.
    const margin = scoreCandidate(perfectLast, seed, opts()).total - scoreCandidate(blindTop, seed, opts()).total;
    expect(margin).toBeGreaterThan(0.05);
    expect(margin).toBeLessThan(0.25);
  });

  it("the artist cooldown DOES bite on real rows — the one term that is not inert", () => {
    // Provider radio leans hard on the seed's own catalogue, so this is the term doing real work
    // in production today. Ban the natural winner's artist and the pick has to move.
    let moved = 0;
    let tested = 0;
    for (const p of pools()) {
      const best = pickBest(p.candidates, p.seed, opts())!;
      if (!best.candidate.track.artist) continue;
      tested++;
      const nearby = [best.candidate.track];
      const after = pickBest(p.candidates, p.seed, opts(nearby))!;
      if (after.candidate.track.videoId !== best.candidate.track.videoId) moved++;
    }
    expect(tested).toBeGreaterThan(0);
    expect(moved).toBe(tested); // every pool: a full-penalty artist block always displaces the pick
  });
});
