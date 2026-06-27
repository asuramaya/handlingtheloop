// Headless sim — runs the REAL game core (clock + gesture + judge + score) at a
// fixed frame rate against a synthetic head-pitch signal, with no Effect House
// runtime. This is what replaces the "shitty React mockup": it tunes windows and
// scoring feel using the exact code that ships.
//
//   npx tsx tools/sim.ts            # play perfectly on the beat
//   npx tsx tools/sim.ts --sloppy   # +/-90ms human error
//
// It synthesizes a head-bop (a downward pitch dip) timed at each note and feeds
// it through the same PeakDetector the component uses.

import { GameClock } from "../core/clock";
import { DEMO_CHART } from "../core/chart";
import { PeakDetector } from "../core/gesture";
import { Judge, scheduleChart } from "../core/judge";
import { ScoreModel } from "../core/score";

const FPS = 30;
const DT = 1 / FPS;
const sloppy = process.argv.includes("--sloppy");

const clock = new GameClock(120, 1.0);
const scheduled = scheduleChart(DEMO_CHART, clock);
const judge = new Judge(scheduled);
const score = new ScoreModel();
const headBop = new PeakDetector("headBop", {
  lowPass: 0.4,
  direction: -1,
  velThresh: 1.2,
  refractory: 0.25,
  latency: -0.08,
});

// pre-compute the time of each synthetic nod (note target + human error)
const nods = scheduled
  .filter((n) => n.type === "headBop")
  .map((n) => n.targetTime + (sloppy ? (Math.sin(n.beatIndex) * 0.09) : 0));

// pitch signal: rest at 0, dip to -0.5 rad over ~120ms around each nod time
function pitchAt(t: number): number {
  let p = 0;
  for (const nt of nods) {
    const d = t - nt;
    if (d > -0.12 && d < 0.12) p += -0.5 * Math.cos((d / 0.12) * (Math.PI / 2));
  }
  return p;
}

const endTime = scheduled[scheduled.length - 1].targetTime + 0.5;
const tally: Record<string, number> = { PERFECT: 0, GREAT: 0, GOOD: 0, MISS: 0 };

for (let t = 0; t <= endTime; t += DT) {
  clock.advance(DT);
  const ev = headBop.feed(pitchAt(t), clock.time, DT);
  if (ev) {
    const hit = judge.resolve(ev);
    if (hit) {
      score.registerHit(hit.verdict, ev.amplitude, hit.note.flourish);
      tally[hit.verdict]++;
    }
  }
  for (const _ of judge.reap(clock.time)) {
    score.registerMiss();
    tally.MISS++;
  }
}

console.log(`mode: ${sloppy ? "sloppy (+/-90ms)" : "on-beat"}`);
console.log(`verdicts: ${JSON.stringify(tally)}`);
console.log(`timing=${score.timing}  style=${score.style}  maxCombo=${score.maxCombo}`);
console.log(`rank: ${score.rank}`);
