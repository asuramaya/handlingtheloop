#!/usr/bin/env node
// SCRATCHWAV — render the jog/scratch SOUND to WAV files for an ear A/B, and measure it.
//
// Operator, 2026-11-10: the scratch is "too high pitched and whiny and not exactly scratchy like it
// does in rekordbox", and micro scratches "sound more like little raygun pew pews, almost like r2d2
// little alien bird whines". Metrics on synthetic tones (scratchreplay.mjs) cannot answer that; an
// ear can. So this drives the REAL scratch worklet (SCRATCH_WORKLET_SRC, unmodified unless a variant
// patches it) offline with a real track's PCM, posts exactly the message stream JogEngine would
// (start / move with dtMs / ~60 Hz settle posts / stop), and writes what it plays.
//
// VARIANTS (same gestures, same track, same levels — no normalisation):
//   current    the shipped worklet
//   reference  an idealised "flagship" model written here: platter position integrated from the
//              ticks at their timestamps, velocity from a Mixxx-style alpha-beta filter run on a
//              1 kHz timer (alpha 1/8, beta = alpha/32 = 1/256, the values Mixxx's controller
//              scripts pass to engine.scratchEnable), the read pointer advanced at that velocity
//              with Catmull-Rom interpolation and the SAME anti-alias lowpass as current (so only
//              the MOTION model differs). No onset / arrival-stop / interval banking.
//   p1-snappy  current with much less pitch smoothing (tau floor 0.4 ms, onset tau 0.5 ms)
//   p2-nomicro current with the from-rest ONSET + micro-jog ARRIVAL STOP disabled
//   p3-darker  current with the anti-alias lowpass at half the cutoff and active from 0.5x
//
// GESTURES (FLX4-style: 720 ticks/rev = 2.5 ms of audio per tick, on a 1 ms USB clock):
//   00-steady-{1x,0.5x,2x}  a perfectly steady turn — must sound exactly like playback
//   01-microjogs           1-4 tick nudges from rest, quick back-and-forth nudges, small wiggles
//   02-baby                baby scratches (±1/8 turn) at 2/3/4 Hz, then forward stabs
//   03-capture             the operator's real FLX4 scratching (fixtures/flx4-jog-real-2026-11-02)
//
//   node scripts/joglab/scratchwav.mjs --pcm track.f32 [--out dir] [--only 00-steady-1x,01-microjogs]
//   (track.f32 = interleaved stereo float32 at 48 kHz, e.g. ffmpeg -i x -ac 2 -ar 48000 -f f32le x.f32)

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { SCRATCH_WORKLET_SRC } from "../../src/htl/audio/scratchWorklet.ts";

const args = process.argv.slice(2);
const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
const SR = 48000;
const Q = 128;
const TICK = 0.0025; // seconds of audio per FLX4 jog tick (720/rev at 33 1/3)
const OUT = opt("--out") ?? "/home/asuramaya/Music/htl-scratch-ab";
const ONLY = opt("--only")?.split(",");
const CAPTURE = new URL("../../src/htl/midi/fixtures/flx4-jog-real-2026-11-02.json", import.meta.url);

// ---- the track ------------------------------------------------------------------------------
const raw = readFileSync(opt("--pcm"));
const inter = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
const LEN = inter.length / 2;
const L = new Float32Array(LEN), R = new Float32Array(LEN);
for (let i = 0; i < LEN; i++) { L[i] = inter[2 * i]; R[i] = inter[2 * i + 1]; }

// ---- gestures: hand position (track sec) → FLX4 ticks on a 1 ms clock ---------------------
// A tick is emitted whenever the quantised hand position changes; several in one 1 ms frame share
// its timestamp, the burstiness measured on the real unit.
function ticksFrom(hand, durS, t0 = 0) {
  const pts = [];
  let tp = Math.round(hand(0) / TICK);
  for (let ms = 0; ms <= durS * 1000; ms++) {
    const want = Math.round(hand(ms / 1000) / TICK);
    while (tp !== want) { tp += Math.sign(want - tp); pts.push({ t: t0 + ms, pos: tp * TICK }); }
  }
  return pts;
}
const steady = (speed, base = 40) => () => {
  const dur = 6;
  return { pts: ticksFrom((t) => base + speed * t, dur), segs: [[-5, dur * 1000 + 5]], dur, base, speed };
};
function microjogs() {
  const base = 61.0;
  const pts = [];
  let cur = base;
  // nudge: n ticks, one per ms (a flick of the finger), starting at time t (ms)
  const nudge = (t, n) => { for (let k = 0; k < Math.abs(n); k++) { cur += Math.sign(n) * TICK; pts.push({ t: t + k, pos: cur }); } };
  const marks = [];
  let t = 300;
  for (const n of [1, 2, 3, 4, 2, 4]) { marks.push({ t, n }); nudge(t, n); t += 600; }
  for (const n of [3, -3, 3, -3, 4, -4]) { marks.push({ t, n }); nudge(t, n); t += 130; }
  t += 500;
  // small wiggles: ±12 ticks (1/60 turn) sine at 7 Hz for 1.2 s — the "micro scratch"
  const w0 = t, wb = cur;
  const wig = (s) => wb + 12 * TICK * Math.sin(2 * Math.PI * 7 * s);
  let tp = Math.round(wig(0) / TICK);
  for (let ms = 0; ms <= 1200; ms++) {
    const want = Math.round(wig(ms / 1000) / TICK);
    while (tp !== want) { tp += Math.sign(want - tp); pts.push({ t: w0 + ms, pos: tp * TICK }); }
  }
  const dur = (w0 + 1500) / 1000;
  for (const m of marks) m.lastT = m.t + Math.abs(m.n) - 1;
  return { pts, segs: [[0, dur * 1000]], dur, marks, wiggle: [w0, w0 + 1200], base };
}
// REAL micro jogs: the small top-plate nudges in the operator's FLX4 capture, replayed with their
// real tick gaps (whole ms, as the recorder stored them), 600 ms of stillness apart. Picked by
// scripts that list every burst of 0x22 ticks after >= 25 ms of quiet (capture t in ms, ticks used):
//   687 x3   the one genuinely slow nudge (gaps 23 15)
//   4 x18, 448 x16, 542 x15, 13382 x24   short complete pushes inside the micro span (gaps 1-11)
//   11233 x4, 11570 x4, 17332 x5, 17553 x3   onsets of longer moves, cut to nudge size
const REAL_MICRO = [[687, 3], [4, 18], [448, 16], [542, 15], [13382, 24], [11233, 4], [11570, 4], [17332, 5], [17553, 3]];
function captureMicro() {
  const cap = JSON.parse(readFileSync(CAPTURE, "utf8"));
  const ev = cap.events ?? cap;
  const t0 = ev[0].t;
  const ticks = ev.filter((e) => e.s === 0xb0 && e.d1 === 0x22).map((e) => ({ t: e.t - t0, d: e.d2 - 64 }));
  const base = 52.0;
  const pts = [], marks = [];
  let cur = base, t = 300;
  for (const [at, cnt] of REAL_MICRO) {
    const i0 = ticks.findIndex((x) => x.t >= at);
    const sel = ticks.slice(i0, i0 + cnt);
    let net = 0;
    for (const x of sel) { cur += x.d * TICK; net += x.d; pts.push({ t: t + (x.t - sel[0].t), pos: cur }); }
    marks.push({ t, n: net, lastT: t + (sel.at(-1).t - sel[0].t), gaps: sel.slice(1).map((x, i) => x.t - sel[i].t) });
    t += Math.max(600, sel.at(-1).t - sel[0].t + 400);
  }
  const dur = (t + 200) / 1000;
  return { pts, segs: [[0, dur * 1000]], dur, marks, base };
}
function baby() {
  const base = 75.0, amp = 90 * TICK; // ±1/8 turn = 90 ticks = 0.225 s of audio
  const phases = [[0, 3, 2], [3, 6, 3], [6, 8, 4]]; // [from s, to s, Hz]
  const hand = (s) => {
    if (s < 8) {
      for (const [a, b, hz] of phases) if (s >= a && s < b) return base + amp * 0.5 * (1 - Math.cos(2 * Math.PI * hz * (s - a)));
    }
    // stabs: a fast forward push of 60 ticks in 60 ms, hold, slow pull back over 300 ms
    const k = (s - 8) % 0.7;
    if (k < 0.06) return base + 60 * TICK * (k / 0.06);
    if (k < 0.3) return base + 60 * TICK;
    if (k < 0.6) return base + 60 * TICK * (1 - (k - 0.3) / 0.3);
    return base;
  };
  const dur = 8 + 0.7 * 4;
  return { pts: ticksFrom(hand, dur), segs: [[-5, dur * 1000 + 5]], dur };
}
function capture() {
  const cap = JSON.parse(readFileSync(CAPTURE, "utf8"));
  const ev = cap.events ?? cap;
  const pts = [], segs = [];
  let pos = 30, down = null;
  const t0 = ev[0].t;
  for (const e of ev) {
    const t = e.t - t0;
    if (t > 15000) break;
    if ((e.s & 0xf0) === 0x90 && e.d1 === 0x36 && (e.s & 0x0f) === 0) {
      if (e.d2 > 0) down = t;
      else if (down != null) segs.push([down, t]), (down = null);
    } else if (e.s === 0xb0 && e.d1 === 0x22) {
      pos += (e.d2 - 64) * TICK;
      pts.push({ t, pos });
    }
  }
  if (down != null) segs.push([down, 15000]);
  return { pts, segs, dur: 15, pos0: 30 };
}
// The same steady 1x turn, but with the messages DELIVERED the way a busy main thread delivers MIDI:
// mostly within ~1.5 ms of the tick, with an occasional 4-8 ms stall that releases a batch at once
// (dtMs is measured at delivery, so this is what the current worklet actually paces from).
function mainthread() {
  const g = steady(1)();
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  let last = -1e9;
  const del = new Map();
  for (const p of g.pts) {
    const j = rnd() < 0.05 ? 4 + rnd() * 4 : rnd() * 1.5;
    last = Math.max(last, p.t + j);
    del.set(p, last);
  }
  g.deliver = (p) => del.get(p) ?? p.t;
  return g;
}
const GESTURES = {
  "00-steady-1x": steady(1),
  "00-steady-1x-mainthread": mainthread,
  "00-steady-0.5x": steady(0.5),
  "00-steady-2x": steady(2),
  "01-microjogs": microjogs,
  "02-baby": baby,
  "03-capture": capture,
  "04-capture-micro": captureMicro,
};

// ---- the real worklet --------------------------------------------------------------------------
const PATCHES = {
  current: [],
  "p1-snappy": [
    ["const tau = this.onset > 0 ? 0.002 : Math.min(0.008, Math.max(0.001, (this.interval / sampleRate) * 0.6));",
     "const tau = this.onset > 0 ? 0.0005 : Math.min(0.008, Math.max(0.0004, (this.interval / sampleRate) * 0.15));"],
  ],
  "p2-nomicro": [
    ["const fromRest =", "let fromRest ="],
    ["const dtIn = d.dtMs > 0", "fromRest = false; const dtIn = d.dtMs > 0"],
  ],
  "p3-darker": [
    ["const targetA = speed > 1 ? 1 - Math.exp(-Math.PI / speed) : 1;",
     "const targetA = speed > 0.5 ? 1 - Math.exp(-Math.PI * 0.5 / speed) : 1;"],
  ],
};
// p4/p5 — THE PROPOSED FIX, as a patch: velocity from a TRACKING ESTIMATOR instead of "ticks counted
// in the last re-pace window ÷ that window". On a steady 1x turn the FLX4 sends a tick every 2.5 ms
// on a 1 ms clock (gaps 2,3,2,3 ms), so a ~13 ms window holds 5 or 6 ticks and the step flips
// between ~0.9x and ~1.1x: frequency modulation, i.e. warble and sideband noise. Here every move
// (tick or settle post) is a (time, position) sample; the velocity is the least-squares slope over
// the last 24 ms of them, and the position error between the fitted hand and the read head is pulled
// out over ~40 ms, so the head never drifts off the platter but no single tick jerks the pitch.
// Settle posts (same position, later time) are samples too, so a stopped hand reads as speed 0.
// p4 times samples with dtMs (main-thread wall clock, what JogEngine posts today); p5 with the
// controller's own tick time (`d.ts`, which MIDIMessageEvent.timeStamp could supply).
const TRACKER = (useTs, tc = 1920) => [
  ["this.micro = false; this.restPos = d.pos;", "this.trkH = []; this.trkT = 0; this.trkTs0 = -1; this.micro = false; this.restPos = d.pos;"],
  ["if (!this.repace) return; // keep the current step; the next re-pace will use the banked time",
   `{
      if (!this.trkH) this.trkH = [];
      ${useTs
        ? "if (this.trkTs0 < 0) this.trkTs0 = d.ts; this.trkT = ((d.ts - this.trkTs0) * sampleRate) / 1000;"
        : "this.trkT = (this.trkT || 0) + dtIn;"}
      const H = this.trkH; H.push(this.trkT, d.pos);
      while (H.length > 4 && this.trkT - H[0] > 1152) H.splice(0, 2); // 24 ms
      const n = H.length / 2; let st = 0, sp = 0, stt = 0, stp = 0;
      for (let i = 0; i < H.length; i += 2) { const t = H[i] - this.trkT, p = H[i + 1] - d.pos; st += t; sp += p; stt += t * t; stp += t * p; }
      const den = n * stt - st * st;
      const v = den > 1e-6 ? (n * stp - st * sp) / den : 0;
      const fit = d.pos + (sp - v * st) / n; // the fitted hand position NOW (tick-quantisation averaged out)
      this.trk = v + (fit - this.pos) / ${tc}; // position pull: no drift, no per-tick jerk
    }`],
  ["this.stepRaw = (this.target - this.pos) / this.interval; // uncapped (granular tracks the finger)", "this.stepRaw = this.trk;"],
];
PATCHES["p4-tracker"] = TRACKER(false);
PATCHES["p5-tracker-ts"] = TRACKER(true);
PATCHES["p5b-tracker-ts-200ms"] = TRACKER(true, 9600);
// THE PROPOSAL: p5b under its listening name (tick timestamps, 24 ms slope, ~200 ms position pull).
PATCHES["p4-proposed"] = TRACKER(true, 9600);
// p6 — Mixxx's own shape inside the worklet: an alpha-beta filter on the platter position, stepped
// every 48 samples (1 kHz, alpha 1/8, beta 1/256), its VELOCITY driving the read head with no
// position pull (as in Mixxx: the filter's x tracks the hand; the head integrates v).
PATCHES["p6-alphabeta"] = [
  ["this.micro = false; this.restPos = d.pos;", "this.abX = d.pos; this.abV = 0; this.abN = 0; this.micro = false; this.restPos = d.pos;"],
  ["this.curStep += (this.step - this.curStep) * this.kStep; // ease toward target velocity",
   "if (++this.abN >= 48) { this.abN = 0; const xp = this.abX + this.abV * 48, r = this.target - xp; this.abX = xp + r / 8; this.abV += r / 256 / 48; } this.curStep = this.micro ? this.curStep + (this.step - this.curStep) * this.kStep : this.abV;"],
];
// Micro-jog HAND TRAJECTORY tuning: segment pacing averaged over the last k tick gaps, and the
// first tick's wait / lone-tick duration.
for (const k of [1, 2, 3, 4]) PATCHES[`tj-avg${k}`] = [["const TJ_AVG = 1;", `const TJ_AVG = ${k};`]];
PATCHES["tj-wait3"] = [["const TJ_WAIT = 0.0065,", "const TJ_WAIT = 0.003,"]];
// Per-sample read speed, logged by a probe patched into every variant (it only reads state).
const PROBE = [
  ["const s = this.readScrub(c, p0, this.pos, sp);", "if (c === 0) globalThis.__spd.push(this.pos - p0); const s = this.readScrub(c, p0, this.pos, sp);"],
  ["this.pos += this.curRaw;", "this.pos += this.curRaw; globalThis.__spd.push(this.curRaw);"],
];
// `before`: another copy of scratchWorklet.ts (e.g. git show <rev>:src/htl/audio/scratchWorklet.ts
// saved to a file), passed with --before <path>, rendered unpatched for a before/after A/B.
const BEFORE_PATH = opt("--before");
const BEFORE_SRC = BEFORE_PATH ? (await import(BEFORE_PATH)).SCRATCH_WORKLET_SRC : null;
PATCHES.before = [];
function makeWorklet(variant) {
  let src = variant === "before" ? BEFORE_SRC : SCRATCH_WORKLET_SRC;
  if (!src) throw new Error("variant 'before' needs --before <path to a scratchWorklet.ts>");
  for (const [from, to] of [...PATCHES[variant], ...PROBE]) {
    const n = src.split(from).length - 1;
    if (n !== 1) throw new Error(`${variant}: patch target found ${n}x: ${from}`);
    src = src.replace(from, to);
  }
  globalThis.sampleRate = SR;
  let Proc = null;
  globalThis.AudioWorkletProcessor = class { constructor() { this.port = { onmessage: null, postMessage() {} }; } };
  globalThis.registerProcessor = (_n, cls) => (Proc = cls);
  delete globalThis.__htlPcm;
  new Function(src)();
  globalThis.__htlPcm.set("A", { gL: [L], gR: [R], length: LEN, pcmScale: 1 });
  return new Proc({ processorOptions: { deckId: "A" } });
}

// The message stream JogEngine posts (same shape scratchreplay.mjs drives): a 'start' per grab, a
// 'move' per tick with dtMs = the wall-clock gap, grabTick's ~60 Hz settle posts when no input
// for >6 ms, a 'stop' on release. Messages land between 128-sample render quanta.
function runWorklet(variant, g) {
  const node = makeWorklet(variant);
  const post = (m) => node.port.onmessage({ data: m });
  const sched = [];
  for (const [a, b] of g.segs) {
    const inSeg = g.pts.filter((p) => p.t >= a && p.t <= b);
    if (!inSeg.length) continue;
    // The grab lands where the platter IS: the last tick before this touch (or the gesture's own
    // start), NOT the first tick of the touch. Starting on the first tick swallowed it (that is
    // why a 1-tick nudge from rest travelled 0 ticks in this harness).
    const prev = g.pts.filter((p) => p.t < a).at(-1);
    const startPos = prev ? prev.pos : (g.base ?? g.pos0 ?? inSeg[0].pos);
    sched.push({ t: a, m: { type: "start", pos: startPos * SR } });
    const dv = (p) => (g.deliver ? g.deliver(p) : p.t);
    let k = 0, lastIn = a, cur = startPos;
    for (let f = a; f <= b; f += 1000 / 60) {
      while (k < inSeg.length && inSeg[k].t <= f) { sched.push({ t: dv(inSeg[k]), m: { type: "move", pos: inSeg[k].pos * SR, ts: inSeg[k].t, hw: true } }); cur = inSeg[k].pos; lastIn = inSeg[k].t; k++; }
      if (f - lastIn > 6) sched.push({ t: f, m: { type: "move", pos: cur * SR, ts: f } });
    }
    for (; k < inSeg.length; k++) sched.push({ t: dv(inSeg[k]), m: { type: "move", pos: inSeg[k].pos * SR, ts: inSeg[k].t, hw: true } });
    sched.push({ t: b, m: { type: "stop" } });
  }
  sched.sort((x, y) => x.t - y.t);
  const n = Math.ceil(((g.dur * 1000 + 100) / 1000) * SR / Q) * Q;
  const outL = new Float32Array(n), outR = new Float32Array(n), spd = new Float32Array(n);
  const out = [new Float32Array(Q), new Float32Array(Q)];
  globalThis.__spd = [];
  let mi = 0, lastMove = -1;
  for (let q = 0; q * Q < n; q++) {
    const tMs = ((q * Q) / SR) * 1000;
    while (mi < sched.length && sched[mi].t <= tMs) {
      const m = { ...sched[mi].m };
      if (m.type === "move") { m.dtMs = lastMove >= 0 ? sched[mi].t - lastMove : 0; lastMove = sched[mi].t; }
      else if (m.type === "start") lastMove = -1;
      post(m);
      mi++;
    }
    const k0 = globalThis.__spd.length;
    node.process([], [out], {});
    const got = globalThis.__spd.length - k0;
    for (let i = 0; i < Q; i++) {
      outL[q * Q + i] = out[0][i]; outR[q * Q + i] = out[1][i];
      spd[q * Q + i] = got === Q ? globalThis.__spd[k0 + i] : 0;
    }
  }
  return { outL, outR, spd };
}

// ---- the reference model -------------------------------------------------------------------------
function runReference(g) {
  const n = Math.ceil(((g.dur * 1000 + 100) / 1000) * SR / Q) * Q;
  const outL = new Float32Array(n), outR = new Float32Array(n), spd = new Float32Array(n);
  const ALPHA = 1 / 8, BETA = ALPHA / 32, DT = 0.001; // Mixxx scratch defaults, 1 kHz timer
  const cub = (buf, p) => {
    const i = Math.floor(p), x = p - i;
    const at = (j) => buf[j < 0 ? 0 : j >= LEN ? LEN - 1 : j];
    const s1 = at(i - 1), s2 = at(i), s3 = at(i + 1), s4 = at(i + 2);
    return s1 * (x * (-0.5 + x * (1 - 0.5 * x))) + s2 * (1 + x * x * (1.5 * x - 2.5)) + s3 * (x * (0.5 + x * (2 - 1.5 * x))) + s4 * (0.5 * x * x * (x - 1));
  };
  const lp = [[0, 0], [0, 0]];
  let grabbed = false, gain = 0, x = 0, v = 0, read = 0, k = 0, meas = 0, lpA = 1;
  const kG = 1 - Math.exp(-1 / (0.004 * SR));
  const segAt = (tMs) => g.segs.some(([a, b]) => tMs >= a && tMs < b);
  for (let ms = 0; ms * SR / 1000 < n; ms++) {
    // ticks up to this ms
    while (k < g.pts.length && g.pts[k].t <= ms) { meas = g.pts[k].pos; k++; }
    const nowGrab = segAt(ms);
    if (nowGrab && !grabbed) {
      const first = g.pts.find((p) => p.t >= ms);
      x = g.base ?? (k > 0 ? meas : first ? first.pos - TICK : 0);
      if (!(k > 0)) meas = x;
      v = 0; read = x * SR;
    }
    grabbed = nowGrab;
    // alpha-beta: predict, correct (Mixxx's scratch filter)
    const vPrev = v;
    const xp = x + v * DT;
    const r = meas - xp;
    x = xp + ALPHA * r;
    v = v + (BETA / DT) * r;
    // audio for this ms at the filtered velocity (linearly interpolated across the ms)
    const s0 = Math.round((ms * SR) / 1000), s1 = Math.round(((ms + 1) * SR) / 1000);
    for (let s = s0; s < s1 && s < n; s++) {
      const f = (s - s0) / (s1 - s0);
      const vel = grabbed ? vPrev + (v - vPrev) * f : 0;
      const sp = Math.abs(vel);
      const tA = sp > 1 ? 1 - Math.exp(-Math.PI / sp) : 1;
      lpA += (tA - lpA) * (0.25 / Q); // the worklet smooths its cutoff once per 128-sample block
      gain += ((grabbed ? 1 : 0) - gain) * kG;
      const p0 = read;
      read += vel;
      spd[s] = read - p0;
      const chs = [L, R];
      for (let c = 0; c < 2; c++) {
        const smp = cub(chs[c], read);
        lp[c][0] += lpA * (smp - lp[c][0]);
        lp[c][1] += lpA * (lp[c][0] - lp[c][1]);
        (c ? outR : outL)[s] = lp[c][1] * gain;
      }
    }
  }
  return { outL, outR, spd };
}
// ---- truth: plain playback of the same excerpt at the steady speed ---------------------------------
function runTruth(g) {
  const n = Math.round(g.dur * SR);
  const outL = new Float32Array(n), outR = new Float32Array(n);
  const p0 = g.base * SR;
  for (let s = 0; s < n; s++) { const i = Math.round(p0 + g.speed * s); outL[s] = L[i]; outR[s] = R[i]; }
  return { outL, outR, spd: new Float32Array(n).fill(g.speed) };
}

// ---- output + measurement ---------------------------------------------------------------------------
function wav(path, l, r) {
  const n = l.length, b = Buffer.alloc(44 + n * 4);
  b.write("RIFF", 0); b.writeUInt32LE(36 + n * 4, 4); b.write("WAVEfmt ", 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(2, 22); b.writeUInt32LE(SR, 24); b.writeUInt32LE(SR * 4, 28);
  b.writeUInt16LE(4, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(l[i] * 32767))), 44 + i * 4);
    b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(r[i] * 32767))), 46 + i * 4);
  }
  writeFileSync(path, b);
}
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let j = 0; j < len / 2; j++) {
        const ur = re[i + j], ui = im[i + j], vr = re[i + j + len / 2] * cr - im[i + j + len / 2] * ci, vi = re[i + j + len / 2] * ci + im[i + j + len / 2] * cr;
        re[i + j] = ur + vr; im[i + j] = ui + vi; re[i + j + len / 2] = ur - vr; im[i + j + len / 2] = ui - vi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}
// Spectral centroid and share of energy above 8 kHz, over frames that are actually sounding.
function spectrum(l, r) {
  const N = 2048, H = 1024, win = new Float32Array(N).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
  let wC = 0, wE = 0, hi = 0, tot = 0;
  for (let s = 0; s + N <= l.length; s += H) {
    const re = new Float32Array(N), im = new Float32Array(N);
    let e = 0;
    for (let i = 0; i < N; i++) { const m = (l[s + i] + r[s + i]) * 0.5; re[i] = m * win[i]; e += m * m; }
    if (Math.sqrt(e / N) < 0.01) continue;
    fft(re, im);
    for (let k = 1; k < N / 2; k++) {
      const p = re[k] * re[k] + im[k] * im[k], f = (k * SR) / N;
      wC += f * p; wE += p; tot += p; if (f > 8000) hi += p;
    }
  }
  return { centroidHz: Math.round(wC / Math.max(1e-12, wE)), above8kPct: +((hi / Math.max(1e-12, tot)) * 100).toFixed(2) };
}
// Steady-turn jitter: deviation of the per-sample read speed from the turn's speed.
function jitter(spd, target, dur) {
  const a = Math.round(0.5 * SR), b = Math.round((dur - 0.2) * SR);
  const d = Array.from(spd.subarray(a, b), (v) => v - target);
  const rms = Math.sqrt(d.reduce((s, x) => s + x * x, 0) / d.length);
  const peak = d.reduce((m, x) => Math.max(m, Math.abs(x)), 0);
  const cents = Math.sqrt(Array.from(spd.subarray(a, b)).reduce((s, v) => { const c = v > 0 ? 1200 * Math.log2(v / target) : 1200; return s + c * c; }, 0) / (b - a));
  const N = 1 << 17, re = new Float32Array(N), im = new Float32Array(N);
  for (let i = 0; i < Math.min(N, d.length); i++) re[i] = d[i];
  fft(re, im);
  let best = 0, bk = 0;
  for (let k = Math.ceil((2 * N) / SR); k < (2000 * N) / SR; k++) { const p = re[k] * re[k] + im[k] * im[k]; if (p > best) { best = p; bk = k; } }
  return { rms: +rms.toFixed(4), peak: +peak.toFixed(3), centsRms: +cents.toFixed(1), modHz: +((bk * SR) / N).toFixed(1) };
}
// Micro-jog nudges: the read-speed curve over each nudge — the "pew" would be a SWEEP.
function nudges(spd, marks) {
  return marks.map(({ t, n, lastT, gaps }, mi) => {
    const s0 = Math.round((t / 1000) * SR), s1 = s0 + Math.round(Math.min(0.2, ((marks[mi + 1]?.t ?? 1e9) - t) / 1000) * SR);
    const seg = Array.from(spd.subarray(s0, s1));
    const peak = seg.reduce((m, x) => (Math.abs(x) > Math.abs(m) ? x : m), 0);
    const on = seg.map((x, i) => [i, Math.abs(x)]).filter(([, x]) => x > Math.abs(peak) * 0.1);
    const durMs = on.length ? +(((on.at(-1)[0] - on[0][0]) / SR) * 1000).toFixed(1) : 0;
    const tPeak = +((seg.findIndex((x) => x === peak) / SR) * 1000).toFixed(1);
    // the hand: ticks [t .. lastT]; when the head starts and stops relative to it
    const moving = seg.map((x, i) => [i, Math.abs(x)]).filter(([, x]) => x > 1e-3);
    const startMs = moving.length ? +((moving[0][0] / SR) * 1000).toFixed(1) : null;
    const stopAfterLastMs = moving.length && lastT != null ? +(((moving.at(-1)[0] / SR) * 1000 - (lastT - t)).toFixed(1)) : null;
    // max travel past the end (overrun), in ticks
    let acc = 0, over = 0;
    for (const x of seg) { acc += x; over = Math.max(over, (acc / SR / TICK - n) * Math.sign(n || 1)); }
    // flutter: RMS cents of the moving speed against its own 10 ms moving average (tick-rate FM)
    let fs = 0, fc = 0;
    for (let i = 240; i < seg.length - 240; i++) {
      const v = Math.abs(seg[i]);
      if (v < 1e-3) continue;
      let a = 0; for (let j = i - 240; j < i + 240; j += 8) a += Math.abs(seg[j]);
      a /= 60;
      if (a > 1e-3) { const c = 1200 * Math.log2(v / a); fs += c * c; fc++; }
    }
    const flutterCents = fc ? Math.round(Math.sqrt(fs / fc)) : 0;
    // speed every 2 ms, 0..40 ms, x realtime
    const curve = Array.from({ length: 21 }, (_, i) => { const j = Math.round((i * 2 * SR) / 1000); return (seg[j] ?? 0).toFixed(2); }).join(" ");
    const travel = seg.reduce((s, x) => s + x, 0) / SR / TICK; // ticks actually travelled
    return { n, gaps: gaps ? gaps.join(",") : undefined, peak: +peak.toFixed(2), tPeakMs: tPeak, durMs, startMs, stopAfterLastMs, overrunTicks: +over.toFixed(3), flutterCents, travelTicks: +travel.toFixed(2), curve };
  });
}

// Responsiveness on a hand gesture: how far the read head trails the hand (position, ms of audio)
// and how well its speed follows the hand's once aligned. Hand = the last tick at each instant.
function follow(spd, g) {
  if (g.segs.length !== 1 || g.speed) return null;
  const n = spd.length, hand = new Float32Array(n);
  let k = 0, hp = g.pts[0].pos - Math.sign(g.pts[1].pos - g.pts[0].pos) * TICK;
  const start = g.base ?? hp;
  for (let s = 0; s < n; s++) { const t = (s / SR) * 1000; while (k < g.pts.length && g.pts[k].t <= t) hp = g.pts[k++].pos; hand[s] = hp; }
  let head = start, se = 0, mx = 0, c = 0;
  const hv = [], rv = [];
  for (let s = 0; s < n; s++) {
    head += spd[s] / SR;
    const e = (head - hand[s]) * 1000; se += e * e; mx = Math.max(mx, Math.abs(e)); c++;
    if (s % 48 === 0 && s >= 480) { hv.push((hand[s] - hand[s - 480]) * 100); rv.push(spd.subarray(s - 480, s).reduce((a, b) => a + b, 0) / 480); }
  }
  let best = { lag: 0, rms: Infinity };
  for (let L = 0; L <= 60; L++) { let e = 0, m = 0; for (let i = L; i < rv.length; i++) { e += (rv[i] - hv[i - L]) ** 2; m++; } const r = Math.sqrt(e / m); if (r < best.rms) best = { lag: L, rms: r }; }
  return { posErrRmsMs: +Math.sqrt(se / c).toFixed(1), posErrMaxMs: +mx.toFixed(1), lagMs: best.lag, alignedSpeedErr: +best.rms.toFixed(3) };
}

mkdirSync(OUT, { recursive: true });
const VARIANTS = (opt("--variants") ?? "current,reference,p1-snappy,p2-nomicro,p3-darker,p4-proposed").split(",");
const report = {};
for (const [name, mk] of Object.entries(GESTURES)) {
  if (ONLY && !ONLY.includes(name)) continue;
  const g = mk();
  report[name] = {};
  const runs = {};
  for (const v of VARIANTS) runs[v] = v === "reference" ? runReference(g) : runWorklet(v, g);
  if (g.speed === 1) runs.truth = runTruth(g);
  for (const [v, r] of Object.entries(runs)) {
    wav(join(OUT, `${name}-${v}.wav`), r.outL, r.outR);
    const m = spectrum(r.outL, r.outR);
    if (g.speed) Object.assign(m, jitter(r.spd, g.speed, g.dur));
    if (g.marks && v !== "truth") m.nudges = nudges(r.spd, g.marks);
    const fo = v === "truth" ? null : follow(r.spd, g);
    if (fo) Object.assign(m, fo);
    report[name][v] = m;
  }
}
writeFileSync(join(OUT, "measurements.json"), JSON.stringify(report, null, 1));
for (const [name, vs] of Object.entries(report)) {
  console.log(`\n== ${name}`);
  for (const [v, m] of Object.entries(vs)) {
    const { nudges: nd, ...rest } = m;
    console.log(`  ${v.padEnd(11)} ${JSON.stringify(rest)}`);
    if (nd) for (const x of nd) console.log(`      nudge ${String(x.n).padStart(3)}${x.gaps != null ? ` gaps[${x.gaps}]` : ""}: peak ${x.peak}x at ${x.tPeakMs} ms, starts ${x.startMs} ms, stops ${x.stopAfterLastMs} ms after the last tick, overrun ${x.overrunTicks}, flutter ${x.flutterCents}c, travel ${x.travelTicks} ticks | ${x.curve}`);
  }
}
