#!/usr/bin/env node
// LIVEPRUNE — does a LIVE AudioContext stop calling process() on a node whose output is cut?
//
// ★ WHY THIS EXISTS. Fx.setBypass carries a load-bearing claim: "once wet→output is cut below, the
// whole upstream chain has no path to the destination and the engine prunes it regardless." That
// sentence is what makes the always-armed rack affordable — chains own their devices now, so a
// busy board is dozens of live worklets, and if a bypassed one still runs, every one of them is
// paid for on the audio thread. It is a closed-world claim about somebody ELSE'S code (the
// browser's), which is the least checkable kind: no grep can falsify it, so it survives forever.
//
// Metron measured it in fxlab's OfflineAudioContext (b15e044d) and got 92.6% — a bypassed device
// costing almost as much as an active one — and correctly refused to claim it, because an offline
// render is not obliged to prune the graph a live one does. His blocker was that
// AudioContext.renderCapacity is not exposed in this Chromium, so there was no live LOAD metric.
//
// ★ THE ANSWER IS NOT A LOAD METRIC. The question is binary — is process() CALLED or not — and a
// processor can count its own invocations. No estimate, no renderCapacity, no profiler.
//
// It needs a browser that actually runs audio. The Claude-in-Chrome rig does NOT: a fresh
// AudioContext there stays `suspended`, resume() never settles, and the comp worklet fails with
// "AudioWorklet does not have a valid AudioWorkletGlobalScope" — which is also why every FX rack on
// that rig degrades to a pass-through. Playwright's Chromium does, with the autoplay flag, and it
// must load a SECURE ORIGIN (about:blank has no ctx.audioWorklet at all).
//
// ★ AND THEN THE SECOND QUESTION, which is the one that turned out to matter. Metron ran the same
// binary method live with a REAL CompFx in the path (2c191cd) and could not get the counter to zero
// even with the device's output SEVERED — so his rig could not observe a prune at all, and his
// bypassed row was unreadable rather than negative. The difference between his chain and the one
// above is not the renderer and not the compressor: it is that every BaseFxDevice hangs a
// permanently-connected AnalyserNode off its wet bus (Fx.ts, `this.wet.connect(this.wetMeter)`),
// and applyWet only ever cuts `wet → output`. So this probe asks the mechanism question directly,
// on a synthetic chain where the analyser is the ONLY thing that changes between rows.
//
// (An AnalyserNode has no outputs, so `analyser.disconnect()` is a no-op — the edge can only be
// severed from the SOURCE side, `wet.disconnect(wetMeter)`. That is why cutting the meter looked
// like it changed nothing.)
//
//   node scripts/liveprune.mjs            # needs the dev worker up for the secure origin
import { chromium } from "playwright-core";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

const ORIGIN = process.env.HTL_ORIGIN || "http://localhost:8787/";
const root = resolve(homedir(), ".cache/ms-playwright");
let exe = null;
if (existsSync(root))
  for (const d of readdirSync(root))
    for (const p of [resolve(root, d, "chrome-linux/chrome"), resolve(root, d, "chrome-headless-shell-linux64/chrome-headless-shell")])
      if (existsSync(p)) { exe = p; break; }

const browser = await chromium.launch({ executablePath: exe ?? undefined, args: ["--autoplay-policy=no-user-gesture-required", "--alsa-output-device=null"] });
const page = await browser.newPage();
try {
  await page.goto(ORIGIN);
} catch {
  console.error(`liveprune: could not load ${ORIGIN} — start the dev worker (npm run worker). A secure origin is required for AudioWorklet.`);
  await browser.close();
  process.exit(1);
}

const r = await page.evaluate(async () => {
  const SRC = `class C extends AudioWorkletProcessor{constructor(){super();this.n=0}process(i,o){this.n++;if(this.n%20===0)this.port.postMessage(this.n);for(const ch of o[0])ch.fill(0);return true}}registerProcessor('c',C)`;
  const ctx = new AudioContext();
  const settled = await Promise.race([ctx.resume().then(() => "resumed"), new Promise((r) => setTimeout(() => r("TIMEOUT"), 3000))]);
  if (settled !== "resumed" || ctx.state !== "running") return { blocked: `context never ran (${settled}, state=${ctx.state})` };
  await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([SRC], { type: "application/javascript" })));
  const node = new AudioWorkletNode(ctx, "c");
  let last = 0;
  node.port.onmessage = (e) => { last = e.data; };
  const osc = ctx.createOscillator();
  const out = ctx.createGain();
  out.gain.value = 0.00001; // inaudible: this measures scheduling, not sound
  osc.connect(node); node.connect(out); out.connect(ctx.destination);
  osc.start();
  const sample = async (ms) => { const a = last; await new Promise((r) => setTimeout(r, ms)); return last - a; };
  await new Promise((r) => setTimeout(r, 400)); // let the graph settle before the baseline
  const connected = await sample(1000);
  out.disconnect();                                 // the setBypass shape: wet→output cut, input still live
  const afterOutputCut = await sample(1000);
  osc.disconnect();                                 // …and with no input either
  const fullyDetached = await sample(1000);
  node.connect(out); out.connect(ctx.destination);  // the control: does it come BACK?
  const reconnected = await sample(1000);

  // ★ THE SECOND EXPERIMENT: IS AN ANALYSER A PATH? — see the header note. Same counter, same
  // context; the only thing that changes is whether an AnalyserNode is hanging off it.
  osc.connect(node);
  out.disconnect();                                 // no route to the destination at all
  const cutAgain = await sample(1000);              // must be 0, or the analyser rows mean nothing
  const analyser = ctx.createAnalyser();
  node.connect(analyser);                           // the ONLY remaining edge out of the counter
  const withAnalyser = await sample(1000);
  node.disconnect(analyser);                        // control: remove it and the counter must stop
  const analyserRemoved = await sample(1000);
  await ctx.close();
  return { connected, afterOutputCut, fullyDetached, reconnected, cutAgain, withAnalyser, analyserRemoved };
});
await browser.close();

if (r.blocked) {
  console.error(`\n  CANNOT ANSWER — ${r.blocked}. This browser has no working audio output, so nothing here is a live measurement.\n`);
  process.exit(1);
}
const pct = (n) => (r.connected ? `${((n / r.connected) * 100).toFixed(1)}%` : "n/a");
console.log("\n  DOES A LIVE AudioContext STOP CALLING process() WHEN wet→output IS CUT?\n");
console.log(`   connected         ${String(r.connected).padStart(5)} process() calls/s   (baseline)`);
console.log(`   wet→output CUT    ${String(r.afterOutputCut).padStart(5)}   ${pct(r.afterOutputCut)}  ← the setBypass shape`);
console.log(`   fully detached    ${String(r.fullyDetached).padStart(5)}   ${pct(r.fullyDetached)}`);
console.log(`   reconnected       ${String(r.reconnected).padStart(5)}   ${pct(r.reconnected)}  ← the control: a zero that cannot come back is a broken probe, not a pruned node`);
const pruned = r.afterOutputCut === 0 && r.reconnected > 0;
console.log(`\n  ${pruned ? "PRUNED — a cut output prunes the upstream chain in a live context, with nothing else attached." : "NOT PRUNED — a bypassed device keeps running its processor; the always-armed rack is paying for it."}\n`);

console.log("  …AND IS AN ANALYSER A PATH? (BaseFxDevice never cuts wet→wetMeter)\n");
console.log(`   cut again         ${String(r.cutAgain).padStart(5)}   ${pct(r.cutAgain)}  ← must be 0 or nothing below is readable`);
console.log(`   + analyser hung on${String(r.withAnalyser).padStart(5)}   ${pct(r.withAnalyser)}  ← the question`);
console.log(`   analyser removed  ${String(r.analyserRemoved).padStart(5)}   ${pct(r.analyserRemoved)}  ← the control: it must stop again`);
if (r.cutAgain !== 0) {
  console.log("\n  INCONCLUSIVE — the reference row did not reach zero, so this rig cannot see a prune here.\n");
  process.exit(0);
}
const analyserHolds = r.withAnalyser > 0 && r.analyserRemoved === 0;
console.log(
  `\n  ${analyserHolds
    ? "AN ANALYSER IS A PATH — an AnalyserNode with no outputs still keeps its whole upstream scheduled.\n  BaseFxDevice's wet bus keeps one connected forever, so cutting wet→output does NOT prune a\n  bypassed device's wet graph. applyWet's \"the ONLY edge\" is one edge short."
    : r.withAnalyser === 0
      ? "AN ANALYSER IS NOT A PATH — an unreachable analyser does not keep its upstream scheduled, so\n  the wet meter is not what kept Metron's CompFx counter running."
      : "INCONCLUSIVE — the analyser row did not come back down; the control failed."}\n`,
);
process.exit(0);
