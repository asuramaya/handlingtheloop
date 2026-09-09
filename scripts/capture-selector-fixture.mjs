#!/usr/bin/env node
// CAPTURE THE SELECTOR'S REAL POPULATION.
//
// ★ OPERATOR RULING (0708130a): capture prod-shaped rows and hold them LOCALLY as a fixture —
// "not even a sim though its just prod shape locally". So nothing here invents a number. Every
// row below comes off the deployed public API, and the only thing this script decides is which
// seeds to ask about.
//
// WHY THIS EXISTS (thread 0ff6100c): the selector's weights were set by reasoning, and dev cannot
// exercise them — plain `vite` has no D1, so /api/analysis answers `{}` and EVERY candidate scores
// analysed:0. Under that, W_ANALYSED is a constant across the pool and cannot change a single
// ranking, so no dev run can tell you whether 0.06 is right, or whether it is doing anything.
//
// ★ AND THE POPULATION IS THE WHOLE POINT, so read this before trusting any number it produces.
// The obvious capture — dump community_tracks, which is "everything we have analysis for" — would
// be the WRONG ROWS, and confidently so: community_tracks is what has been CACHED, whereas the
// selector scores what provider radio RETURNS, and those two sets barely overlap. Sampling the
// cached set would report an analysed-rate far above the one the mixer actually faces, and the
// weights would be tuned against a population that never reaches scoreCandidate.
//
// So the capture is pool-shaped, not table-shaped:
//   1. real seeds     — /api/community, tracks people actually loaded
//   2. real pools     — /api/recommend?v=<seed>, the SAME call queue.ts makes, in provider order
//   3. real coverage  — /api/analysis?ids=<the pool>, which of those prod actually knows
// `rel` is deliberately NOT captured: it is derived client-side from rank (queue.ts:357), so the
// fixture stores ORDER and the reader recomputes rel exactly as the app does. Storing it would be
// a second copy of a formula, free to drift from the one that ships.
//
// Read-only. Public endpoints, no auth, nothing posted. Re-run to refresh:
//   node scripts/capture-selector-fixture.mjs [--origin https://handlingtheloop.com] [--seeds 8]
import { writeFileSync } from "node:fs";

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const ORIGIN = arg("origin", "https://handlingtheloop.com").replace(/\/$/, "");
const SEEDS = Number(arg("seeds", "8"));
const OUT = arg("out", "src/htl/automix/__fixtures__/selectorPools.json");
// Skip the first N community rows — the way to take a DISJOINT second sample and check the first
// one against it. A single capture has nothing to disagree with, which is the cheapest bug there is.
const OFFSET = Number(arg("offset", "0"));

const get = async (path) => {
  const r = await fetch(`${ORIGIN}${path}`, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return r.json();
};
// Politeness, not correctness: these are one operator's own endpoints and there is no hurry.
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

const { tracks = [] } = await get(`/api/community?limit=${OFFSET + SEEDS * 3}`);
const seeds = tracks.filter((t) => /^[\w-]{11}$/.test(t.videoId)).slice(OFFSET, OFFSET + SEEDS);
if (!seeds.length) throw new Error("no seeds — /api/community returned nothing usable");

const pools = [];
for (const s of seeds) {
  try {
    const { candidates = [] } = await get(`/api/recommend?v=${s.videoId}&limit=30`);
    pools.push({
      seed: { videoId: s.videoId, title: s.title, artist: s.artist, duration: s.duration },
      // Provider order preserved — it IS the rel signal.
      candidates: candidates.map((c) => ({ videoId: c.videoId, title: c.title, artist: c.artist, duration: c.duration })),
    });
    process.stderr.write(`${s.videoId}  ${candidates.length} candidates  ${s.title}\n`);
  } catch (e) {
    process.stderr.write(`${s.videoId}  SKIPPED (${e.message})\n`);
  }
  await pause(300);
}

// Coverage over the POOLS' own ids — never over the cached table.
const ids = [...new Set(pools.flatMap((p) => p.candidates.map((c) => c.videoId)))];
const analysis = {};
for (let i = 0; i < ids.length; i += 100) {
  const batch = ids.slice(i, i + 100); // the endpoint's own cap (getAnalysisByIds slices to 100)
  const r = await get(`/api/analysis?ids=${batch.join(",")}`);
  Object.assign(analysis, r.analysis ?? {});
  await pause(200);
}

const known = ids.filter((id) => analysis[id]);
const withBpm = known.filter((id) => analysis[id].bpm != null);
const withKey = known.filter((id) => analysis[id].key != null);
const withEnergy = known.filter((id) => analysis[id].energy != null);
const fixture = {
  capturedAt: new Date().toISOString(),
  origin: ORIGIN,
  // The census travels WITH the rows, so a reader can never quote a number from this file without
  // seeing which population it came from.
  // ★ TWO POPULATIONS, NAMED SEPARATELY, because they are not the same number and the difference
  // is exactly the kind that gets quoted wrong. `distinct` counts each track once — the right
  // denominator for "how much of the catalogue is analysed". `occurrences` counts a track once per
  // pool it appears in — the right denominator for "what does the selector score", since a track
  // in two pools is scored twice. They differ here because radio lists overlap.
  census: {
    seeds: pools.length,
    candidates: pools.reduce((n, p) => n + p.candidates.length, 0), // occurrences: what gets scored
    distinct: ids.length, // unique tracks: what gets analysed
    analysed: known.length, // over `distinct`
    withBpm: withBpm.length,
    withKey: withKey.length,
    withEnergy: withEnergy.length,
    // The same coverage over OCCURRENCES — the rate a pick actually faces.
    analysedOccurrences: pools.reduce((n, p) => n + p.candidates.filter((c) => analysis[c.videoId]).length, 0),
    energyOccurrences: pools.reduce((n, p) => n + p.candidates.filter((c) => analysis[c.videoId]?.energy != null).length, 0),
  },
  pools,
  analysis,
};
writeFileSync(OUT, `${JSON.stringify(fixture, null, 2)}\n`);
process.stderr.write(`\n${OUT}\n${JSON.stringify(fixture.census)}\n`);
