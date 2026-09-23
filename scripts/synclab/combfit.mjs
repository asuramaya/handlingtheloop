#!/usr/bin/env node
// COMBFIT — does a CONSTANT comb (firstBeat + k·interval) describe a real track's beats?
//
// 77a3adac's second remaining item is "constant-vs-dynamic fit on real material", and I had it
// filed as blocked for wanting real tracks. The material was already in the repo:
// scripts/synclab/real-grids.json holds four grids this build's detector produced on real tracks,
// read out of the local cache — captured for the sync work, never asked this question.
//
// The standing rule it tests: `interval` as a DURATION is safe anywhere; `firstBeat + k·interval`
// as a POSITION is the defect. That was reasoning. This is the number.
//
// ★ TWO MEASURES, BECAUSE THE FIRST ONE SATURATES. Deviation-to-nearest-comb-tooth folds anything
// past half a beat back toward zero — so three grids read "50.0%" and that is the metric hitting
// its ceiling, not a measurement. Cumulative END DRIFT is unfolded and says how far the comb
// actually walked. Reporting only the first would have looked like a stronger result and meant
// less.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const { grids, caveat } = JSON.parse(readFileSync(resolve(here, "real-grids.json"), "utf8"));

console.log("\n  COMBFIT — constant comb vs the tracked beats, on real material\n");
console.log(`  ${"video".padEnd(13)} ${"bpm".padStart(7)} ${"beats".padStart(6)} ${"rms".padStart(9)} ${"worst".padStart(9)} ${"end drift".padStart(11)}`);
for (const g of grids) {
  const { beats: b, firstBeat: f, interval: iv } = g;
  const devs = b.map((t) => t - (f + Math.round((t - f) / iv) * iv));
  const rms = Math.sqrt(devs.reduce((a, x) => a + x * x, 0) / devs.length);
  const worst = Math.max(...devs.map(Math.abs));
  const drift = b[b.length - 1] - (f + (b.length - 1) * iv);
  console.log(
    `  ${g.videoId.padEnd(13)} ${g.bpm.toFixed(2).padStart(7)} ${String(b.length).padStart(6)} ` +
      `${(rms / iv * 100).toFixed(1).padStart(8)}% ${(worst / iv * 100).toFixed(1).padStart(8)}% ${(drift / iv).toFixed(2).padStart(9)}b`,
  );
}
console.log(`\n  rms/worst are folded to the nearest tooth, so 50% is the CEILING, not a reading.`);
console.log(`  end drift is unfolded: how far the comb's last tooth sits from the tracked last beat, in beats.`);
console.log(`\n  CAVEAT, from the fixture itself: ${caveat.slice(0, 180)}…\n`);
