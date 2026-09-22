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
  await ctx.close();
  return { connected, afterOutputCut, fullyDetached, reconnected };
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
console.log(`\n  ${pruned ? "PRUNED — Fx.setBypass's claim HOLDS in a live context. A bypassed device is free." : "NOT PRUNED — a bypassed device keeps running its processor; the always-armed rack is paying for it."}\n`);
process.exit(0);
