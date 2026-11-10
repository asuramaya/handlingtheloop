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
  for (let k = 1; k <= ticks; k++) sched.push({ t: Math.round(t0 + (durMs * k) / ticks), m: { type: "move", pos: start + dir * k * TICK, ts: Math.round(t0 + (durMs * k) / ticks), hw: true } });
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

// RING SEARCH (paused): the outer ring turned slowly and steadily, `spacingMs` between ticks, for
// 400 ms, then still. grabTick posts the held position at each ~60 Hz frame once no input has
// arrived for STALE ms (JogEngine: 6 ms). Operator, 2026-11-03: the paused ring is "kind of choppy
// instead of giving me micro adjustment".
//   parkedPct  share of the turning phase the head sat still (stop-go = choppy)
//   speedCv    spread of the head's speed while turning (std / true ring speed; 0 = perfectly even)
//   overrunMs  past the final position after the ring stops
const STALE = Number(args.includes("--stale") ? args[args.indexOf("--stale") + 1] : 6);
function ring(spacingMs) {
  const node = makeWorklet();
  const post = (m) => node.port.onmessage({ data: m });
  const start = 10 * SR;
  const sched = [{ t: 0, m: { type: "start", pos: start } }];
  const t0 = 50, turn = 400;
  const ticks = [];
  for (let t = t0; t <= t0 + turn; t += spacingMs) ticks.push(Math.round(t));
  ticks.forEach((t, k) => sched.push({ t, m: { type: "move", pos: start + (k + 1) * TICK } }));
  const end = start + ticks.length * TICK;
  for (let f = 1000 / 60; f < t0 + turn + 250; f += 1000 / 60) {
    let k = 0;
    while (k < ticks.length && ticks[k] <= f) k++;
    const since = k === 0 ? f : f - ticks[k - 1];
    if (since > STALE) sched.push({ t: f, m: { type: "move", pos: start + k * TICK } });
  }
  sched.sort((a, b) => a.t - b.t);
  const out = [new Float32Array(Q), new Float32Array(Q)];
  const msPerQ = (Q / SR) * 1000;
  let mi = 0, lastMove = -1, prev = start, maxPast = 0;
  const sp = [];
  for (let t = 0; t < t0 + turn + 250; t += msPerQ) {
    while (mi < sched.length && sched[mi].t <= t) {
      const m = { ...sched[mi].m };
      if (m.type === "move") { m.dtMs = lastMove >= 0 ? sched[mi].t - lastMove : 0; lastMove = sched[mi].t; }
      post(m); mi++;
    }
    node.process([], [out], {});
    const v = (node.pos - prev) / Q; prev = node.pos;
    if (t > t0 + 60 && t < t0 + turn) sp.push(v);
    maxPast = Math.max(maxPast, node.pos - end);
  }
  const want = TICK / ((spacingMs / 1000) * SR); // the ring's true speed, × realtime
  const mean = sp.reduce((a, b) => a + b, 0) / sp.length;
  const sd = Math.sqrt(sp.reduce((a, b) => a + (b - mean) ** 2, 0) / sp.length);
  return {
    ring: `${spacingMs}ms/tick (${want.toFixed(3)}x)`,
    parkedPct: +((sp.filter((v) => Math.abs(v) < want * 0.1).length / sp.length) * 100).toFixed(1),
    speedCv: +(sd / want).toFixed(2),
    meanVsTrue: +(mean / want).toFixed(2),
    overrunMs: +((Math.max(0, maxPast) / SR) * 1000).toFixed(1),
  };
}
console.log("ring search, stale", STALE, "ms");
console.table([3, 6, 10, 20, 35, 60].map(ring));

const rows = [];
for (const [ticks, ms] of [[1, 1], [2, 4], [4, 10], [4, 30], [8, 20], [8, 60], [16, 40]]) rows.push(nudge(ticks, ms));
console.log(JSON.stringify({ patches }));
console.table(rows);
