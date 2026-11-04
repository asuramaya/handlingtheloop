#!/usr/bin/env node
// MICROJOG — the REAL scratch worklet, driven by a short nudge on a still platter, measured for
// what the operator calls "slurry": micro jogs "still need work for the slurry feel and sound"
// (2026-11-03, after the onset fix made them feel much better).
//
// A micro jog is a burst of a few jog ticks (2.5 ms of audio each on a DDJ-FLX4) and then a still
// hand. scratchreplay.mjs scores continuous scratching; this scores the END of a small move, which
// that never isolates: does the read head stop where the hand stopped, or carry on and come back?
//
// Input: board-shaped ticks (one message per tick, on a 1 ms USB clock), then grabTick's ~60 Hz
// settle posts of the unchanged position while the hand is held, exactly as JogEngine posts them.
//
// METRICS per nudge (ticks × duration):
//   overrunMs   how far past the hand's final position the head went, in ms of audio
//   overrunPct  … as a share of the nudge itself
//   backtrack   did the head reverse to come back (a forward-then-back the hand never made)
//   settleMs    from the last tick until the head is within 0.1 ms of the hand and still
//   lag50Ms     from the first tick until the head has covered half the nudge
//
//   node scripts/joglab/microjog.mjs [--patch 'from=>to' ...]

import { SCRATCH_WORKLET_SRC } from "../../src/htl/audio/scratchWorklet.ts";

const args = process.argv.slice(2);
const patches = args.flatMap((a, i) => (a === "--patch" ? [args[i + 1]] : []));
const SR = 48000;
const Q = 128;
const TICK = 0.0025 * SR; // samples of audio per jog tick

function makeWorklet() {
  let src = SCRATCH_WORKLET_SRC;
  for (const p of patches) {
    const [from, to] = p.split("=>");
    if (!src.includes(from)) throw new Error(`--patch target not found: ${JSON.stringify(from)}`);
    src = src.split(from).join(to);
  }
  globalThis.sampleRate = SR;
  let Proc = null;
  globalThis.AudioWorkletProcessor = class {
    constructor() {
      this.port = { onmessage: null, postMessage() {} };
    }
  };
  globalThis.registerProcessor = (_n, cls) => (Proc = cls);
  delete globalThis.__htlPcm;
  new Function(src)();
  const LEN = SR * 30;
  const tone = new Float32Array(LEN).map((_, i) => Math.sin((2 * Math.PI * 220 * i) / SR) * 0.5);
  globalThis.__htlPcm.set("A", { gL: [tone], gR: [tone], length: LEN, pcmScale: 1 });
  return new Proc({ processorOptions: { deckId: "A" } });
}

function nudge(ticks, durMs, dir = 1) {
  const node = makeWorklet();
  const post = (m) => node.port.onmessage({ data: m });
  const start = 10 * SR;
  const end = start + dir * ticks * TICK;
  // schedule: grab at t=0, hand still 40 ms, ticks evenly over durMs (whole-ms USB frames), held 200 ms
  const sched = [{ t: 0, m: { type: "start", pos: start } }];
  for (let f = 1000 / 60; f < 40; f += 1000 / 60) sched.push({ t: f, m: { type: "move", pos: start } });
  const t0 = 40;
  for (let k = 1; k <= ticks; k++) sched.push({ t: Math.round(t0 + (durMs * k) / ticks), m: { type: "move", pos: start + dir * k * TICK } });
  const tLast = sched.at(-1).t;
  for (let f = tLast + 1000 / 60; f < tLast + 200; f += 1000 / 60) sched.push({ t: f, m: { type: "move", pos: end } });
  sched.sort((a, b) => a.t - b.t);

  const out = [new Float32Array(Q), new Float32Array(Q)];
  const msPerQ = (Q / SR) * 1000;
  let mi = 0;
  let lastMove = -1;
  let maxPast = 0;
  let reversed = false;
  let prevDir = 0;
  let lag50 = null;
  let settled = null;
  let prevPos = start;
  for (let t = 0; t < tLast + 200; t += msPerQ) {
    while (mi < sched.length && sched[mi].t <= t) {
      const m = { ...sched[mi].m };
      if (m.type === "move") {
        m.dtMs = lastMove >= 0 ? sched[mi].t - lastMove : 0;
        lastMove = sched[mi].t;
      }
      post(m);
      mi++;
    }
    node.process([], [out], {});
    const pos = node.pos;
    const past = (pos - end) * dir;
    if (past > maxPast) maxPast = past;
    const d = Math.sign(pos - prevPos);
    if (Math.abs(pos - prevPos) > 0.5) {
      if (prevDir && d !== prevDir) reversed = true;
      prevDir = d;
    }
    prevPos = pos;
    if (lag50 == null && (pos - start) * dir >= (ticks * TICK) / 2) lag50 = t - t0;
    if (t > tLast && settled == null && Math.abs(pos - end) < 0.0001 * SR && Math.abs(node.curStep) < 0.01) settled = t - tLast;
  }
  const r = (x) => +x.toFixed(1);
  return {
    nudge: `${ticks}t/${durMs}ms`,
    overrunMs: r((maxPast / SR) * 1000),
    overrunPct: r((maxPast / (ticks * TICK)) * 100),
    backtrack: reversed,
    settleMs: settled == null ? ">200" : r(settled),
    lag50Ms: lag50 == null ? "never" : r(lag50),
  };
}

const rows = [];
for (const [ticks, ms] of [[1, 1], [2, 4], [4, 10], [4, 30], [8, 20], [8, 60], [16, 40]]) rows.push(nudge(ticks, ms));
console.log(JSON.stringify({ patches }));
console.table(rows);
