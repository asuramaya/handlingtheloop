#!/usr/bin/env node
// SCRATCHREPLAY — drive the REAL scratch worklet offline with hand-scratch input and measure what
// the operator described as "smeared, trips over itself, like a poorly done FF/RW" — reported as
// "not nearly as bad on touch, noticeably worse on mouse, and super bad on board".
//
// joglab.mjs covers the worklet's motor ramps only. Nothing covered HAND scratching. This evaluates
// scratchWorklet.ts's own SCRATCH_WORKLET_SRC under minimal AudioWorkletGlobalScope shims (none of
// its math is reimplemented), posts the 'start'/'move'/'stop' stream JogEngine would post — with
// dtMs as the real gap between posts, and grabTick's ~60 Hz held-position settle posts — delivered
// between render quanta the way a MessagePort is, and records the worklet's own state per quantum.
//
// INPUT SHAPES. The operator's ranking (touch < mouse < board) lines up with how each input
// REPORTS, not with what the hand does, so `--input` drives ONE identical hand motion through:
//   touch   ~60 Hz, regular, exact positions
//   mouse   1000 Hz samples quantised to whole pixels, delivered in a burst once per ~60 Hz frame
//           (coalesced pointer events are handled per frame)
//   board   720-tick/rev quantised jog ticks (one per 2.5 ms of audio), on a 1 ms USB clock, with
//           the measured burstiness (several ticks per 1 ms frame at speed)
// or `--capture file.json` replays a real controller capture (MidiDebug format).
//
// METRICS (while gripped):
//   granularPct  share of quanta in GRANULAR mode (45 ms grains = needle-search = the FF/RW sound)
//   jitterRms    RMS of (worklet read speed − true hand speed), × realtime
//   trips        worklet speed reversals the hand did not make
//
//   node scripts/joglab/scratchreplay.mjs --input touch|mouse|board|all [--patch 'from=>to' ...]
//   node scripts/joglab/scratchreplay.mjs --capture <file.json> [--patch ...]

import { readFileSync } from "node:fs";
import { SCRATCH_WORKLET_SRC } from "../../src/htl/audio/scratchWorklet.ts";

const args = process.argv.slice(2);
const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
const patches = args.flatMap((a, i) => (a === "--patch" ? [args[i + 1]] : []));
const SR = 48000;
const Q = 128;
const SEC_PER_TICK = 0.0025;

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
  const LEN = SR * 60;
  const tone = new Float32Array(LEN).map((_, i) => Math.sin((2 * Math.PI * 220 * i) / SR) * 0.5);
  globalThis.__htlPcm.set("A", { gL: [tone], gR: [tone], length: LEN, pcmScale: 1 });
  return new Proc({ processorOptions: { deckId: "A" } });
}

// ONE hand motion for every synthetic input: 1 s still-ish slow drag, then 2 s of baby scratches
// (4 Hz), then 1 s of fast scratches (7 Hz, larger). Position in track seconds, from 10 s.
const handPos = (t) => {
  if (t < 1) return 10 + 0.35 * t; // slow forward drag, 0.35×
  if (t < 3) return 10.35 + 0.06 * Math.sin(2 * Math.PI * 4 * (t - 1)); // baby scratches, peak ~1.5×
  return 10.35 + 0.12 * Math.sin(2 * Math.PI * 7 * (t - 3)); // fast scratches, peak ~5.3×
};
const handVel = (t) => (handPos(t + 1e-4) - handPos(t - 1e-4)) / 2e-4;
const DUR = 4;

// Each input → [{ t (ms), pos (track sec) }] plus a truth function (× realtime at t ms).
function synth(kind) {
  const pts = [];
  if (kind === "touch") {
    for (let t = 0; t <= DUR; t += 1 / 60) pts.push({ t: t * 1000, pos: handPos(t) });
  } else if (kind === "mouse") {
    const px = 0.002; // one pixel = 2 ms of audio at a typical zoom
    let frameBuf = [];
    let nextFrame = 1 / 60;
    for (let t = 0; t <= DUR; t += 0.001) {
      frameBuf.push(Math.round(handPos(t) / px) * px);
      if (t >= nextFrame) {
        for (const p of frameBuf) pts.push({ t: t * 1000, pos: p }); // whole frame's samples at once
        frameBuf = [];
        nextFrame += 1 / 60;
      }
    }
  } else if (kind === "board") {
    let tickPos = Math.round(handPos(0) / SEC_PER_TICK);
    for (let t = 0; t <= DUR; t += 0.001) {
      // ticks owed this 1 ms USB frame; the FLX4 sends them as several messages in the same frame
      const want = Math.round(handPos(t) / SEC_PER_TICK);
      while (tickPos !== want) {
        tickPos += Math.sign(want - tickPos);
        pts.push({ t: t * 1000, pos: tickPos * SEC_PER_TICK });
      }
    }
  }
  return { pts, truth: (tMs) => handVel(tMs / 1000) };
}

function fromCapture(file) {
  const cap = JSON.parse(readFileSync(file, "utf8"));
  const ev = cap.events ?? cap;
  const pts = [];
  const segs = [];
  let pos = 10;
  let down = null;
  const ticks = [];
  for (const e of ev) {
    if ((e.s & 0xf0) === 0x90 && e.d1 === 0x36 && (e.s & 0x0f) === 0) {
      if (e.d2 > 0) down = e.t;
      else if (down != null) segs.push([down, e.t]), (down = null);
    } else if (e.s === 0xb0 && e.d1 === 0x22) {
      pos += (e.d2 - 64) * SEC_PER_TICK;
      pts.push({ t: e.t, pos });
      ticks.push({ t: e.t, d: e.d2 - 64 });
    }
  }
  const W = 15;
  return {
    pts,
    segs,
    truth: (t) => {
      let s = 0;
      for (const x of ticks) if (x.t >= t - W && x.t <= t + W) s += x.d;
      return (s * SEC_PER_TICK) / ((2 * W) / 1000);
    },
  };
}

function run({ pts, truth, segs }) {
  const node = makeWorklet();
  const post = (m) => node.port.onmessage({ data: m });
  // Build the message schedule: one 'start' per gripped segment, a 'move' per input sample, and
  // grabTick's settle posts (~60 Hz, when no input for >6 ms), one 'stop' at the end.
  const ranges = segs ?? [[pts[0].t - 1, pts.at(-1).t + 1]];
  const sched = [];
  for (const [a, b] of ranges) {
    const inSeg = pts.filter((p) => p.t >= a && p.t <= b);
    if (!inSeg.length) continue;
    sched.push({ t: a, m: { type: "start", pos: inSeg[0].pos * SR } });
    let k = 0;
    let lastIn = a;
    let cur = inSeg[0].pos;
    for (let f = a; f <= b; f += 1000 / 60) {
      while (k < inSeg.length && inSeg[k].t <= f) {
        sched.push({ t: inSeg[k].t, m: { type: "move", pos: inSeg[k].pos * SR } });
        cur = inSeg[k].pos;
        lastIn = inSeg[k].t;
        k++;
      }
      if (f - lastIn > 6) sched.push({ t: f, m: { type: "move", pos: cur * SR } });
    }
    for (; k < inSeg.length; k++) sched.push({ t: inSeg[k].t, m: { type: "move", pos: inSeg[k].pos * SR } });
    sched.push({ t: b, m: { type: "stop" } });
  }
  sched.sort((x, y) => x.t - y.t);
  const out = [new Float32Array(Q), new Float32Array(Q)];
  const msPerQ = (Q / SR) * 1000;
  let mi = 0;
  let lastMove = -1;
  let gran = 0, n = 0;
  let prev = 0;
  const S = []; // worklet read speed per quantum
  const T = []; // truth per quantum
  for (let t = sched[0].t; t < sched.at(-1).t + 50; t += msPerQ) {
    while (mi < sched.length && sched[mi].t <= t) {
      const m = { ...sched[mi].m };
      if (m.type === "move") {
        m.dtMs = lastMove >= 0 ? sched[mi].t - lastMove : 0; // performance.now() gap, as JogEngine measures
        lastMove = sched[mi].t;
      } else if (m.type === "start") {
        lastMove = -1;
        prev = m.pos;
      }
      post(m);
      mi++;
    }
    node.process([], [out], {});
    const speed = (node.pos - prev) / Q;
    prev = node.pos;
    if (!(node.active && node.gainTarget > 0)) continue;
    if (node.granular) gran++;
    S.push(speed);
    T.push(truth(t));
    n++;
  }
  // LAG is not roughness. A 60 Hz input makes the feed-forward glide trail the hand by ~one update;
  // at 7 Hz scratches that delay alone is ~3× of RMS error, and the first version of this metric
  // ranked touch WORST for exactly that reason. So: find the delay that best aligns worklet speed
  // with the truth, score the error after alignment, and score ROUGHNESS separately as the worklet
  // speed's deviation from its own ~8 ms moving average (stair-steps, zipper, momentary spikes).
  let best = { lag: 0, rms: Infinity };
  for (let L = 0; L <= 16; L++) { // 0..~43 ms in quanta
    let se = 0, m = 0;
    for (let i = L; i < n; i++) { se += (S[i] - T[i - L]) ** 2; m++; }
    const rms = Math.sqrt(se / m);
    if (rms < best.rms) best = { lag: L, rms };
  }
  const half = 1; // ±1 quantum ≈ 8 ms window
  let rough = 0, trips = 0, pw = 0, pt = 0;
  for (let i = 0; i < n; i++) {
    let s = 0, c = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(n - 1, i + half); j++) { s += S[j]; c++; }
    rough += (S[i] - s / c) ** 2;
    const tr = T[i - best.lag] ?? 0; // compare reversals against the ALIGNED truth
    const w = Math.abs(S[i]) > 0.1 ? Math.sign(S[i]) : 0;
    const tv = Math.abs(tr) > 0.1 ? Math.sign(tr) : 0;
    if (w && pw && w !== pw && !(tv && pt && tv !== pt)) trips++;
    if (w) pw = w;
    if (tv) pt = tv;
  }
  return {
    activeS: +((n * Q) / SR).toFixed(2),
    updates: pts.length,
    granularPct: +((gran / n) * 100).toFixed(1),
    lagMs: +((best.lag * Q * 1000) / SR).toFixed(1),
    alignedErrRms: +best.rms.toFixed(3),
    roughnessRms: +Math.sqrt(rough / n).toFixed(3),
    trips,
  };
}

const cap = opt("--capture");
const kinds = cap ? [] : opt("--input") === "all" || !opt("--input") ? ["touch", "mouse", "board"] : [opt("--input")];
const result = {};
if (cap) result.capture = run(fromCapture(cap));
for (const k of kinds) result[k] = run(synth(k));
console.log(JSON.stringify({ patches, ...result }, null, 1));
