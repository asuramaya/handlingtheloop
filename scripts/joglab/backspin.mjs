#!/usr/bin/env node
// BACKSPIN — render jog THROWS and BACKSPINS to WAV, through the real JogEngine + the real scratch
// worklet + a replica of useMidiRouting's FLX4 vinyl-mode routing (touch, 0x22 scratch ticks, the
// post-release 0x21 free-spin ticks and the free-spin follow), and print the speed-vs-time curve.
//
// Operator, 2026-11-10 (DDJ-FLX4, vinyl mode): "the backspin on rekordbox is more aggressive and I
// can't quite match the feel or sound of it". scratchwav.mjs posts a hand-made message stream to the
// worklet; a release is decided by JogEngine (decideRelease, the coast, the motor ramp) and, on the
// FLX4, by the routing's free-spin follow, so this drives those for real instead of replicating them.
//
//   node --experimental-transform-types scripts/joglab/scratchwav.mjs --backspin --pcm track.f32 \
//        [--src <checkout root, default this one>] [--tag after] [--out dir] [--only fwd-3x,back-10x]
//
// --src points the run at another checkout's src/ (e.g. an extracted HEAD) so before/after use the
// SAME gestures. Clocks are simulated: ctx.currentTime, performance.now() and requestAnimationFrame
// (60 Hz) all run on the render clock, MIDI ticks carry their 1 ms USB timestamps, and the routing's
// 15 ms follow checker runs on it too.
//
// The FLX4 platter has no motor: after the touch-up it spins free and keeps sending CC 0x21. Its
// decay is taken from the operator's capture (fixtures/flx4-jog-real-2026-11-02.json, four backspins
// at 4.3-8.0 s): the free speed halves every ~100 ms (exponential, tau ~0.145 s), and starts at the
// speed of the hand's last push.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

// The app's TS imports are extensionless ("./scratchPatterns"): resolve them to .ts.
registerHooks({
  resolve(spec, ctx, next) {
    try {
      return next(spec, ctx);
    } catch (e) {
      if (spec.startsWith(".")) return next(spec + ".ts", ctx);
      throw e;
    }
  },
});

const args = process.argv.slice(2);
const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
const SR = 48000;
const Q = 128;
const TICK = 0.0025; // FLX4: seconds of audio per jog tick (SEC_PER_TICK in useMidiRouting)
const FREE_TAU = 0.145; // FLX4 free-spin decay (s), fitted to the capture
const SRC = resolve(opt("--src") ?? new URL("../..", import.meta.url).pathname);
const TAG = opt("--tag") ?? "run";
const OUT = opt("--out") ?? "/home/asuramaya/Music/htl-scratch-ab/backspin";
const ONLY = opt("--only")?.split(",");

const { JogEngine } = await import(pathToFileURL(join(SRC, "src/htl/audio/JogEngine.ts")).href);
const { SCRATCH_WORKLET_SRC } = await import(pathToFileURL(join(SRC, "src/htl/audio/scratchWorklet.ts")).href);
const follow = await import(pathToFileURL(join(SRC, "src/App/jogSpinFollow.ts")).href);
// The routing changed with the physics: the new one hands a playing deck to the motor ~30 ms after the
// touch-up (SPIN_MEASURE_MS), stamps free-spin ticks, and swallows the rest of the free spin.
const NEW_ROUTING = follow.SPIN_MEASURE_MS !== undefined;

// ---- the track ------------------------------------------------------------------------------
const raw = readFileSync(opt("--pcm"));
const inter = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
const LEN = inter.length / 2;
const L = new Float32Array(LEN), R = new Float32Array(LEN);
for (let i = 0; i < LEN; i++) { L[i] = inter[2 * i]; R[i] = inter[2 * i + 1]; }

// ---- gestures ---------------------------------------------------------------------------------
// A gesture: the deck plays (or sits paused) from `pos`; at `grab` s the hand touches the platter,
// holds it still for `hold` s, then its speed ramps to `v` over `ramp` s and stays there for `keep` s;
// the touch lifts at the end of that and the platter spins free. Events on a 1 ms clock.
function throwGesture({ play = true, pos = 60, grab = 0.8, hold = 0.12, ramp = 0.08, v, keep = 0, dur = 4.5 }) {
  const ev = [];
  const t0 = grab * 1000, t1 = t0 + hold * 1000, t2 = t1 + ramp * 1000, tUp = t2 + keep * 1000;
  ev.push({ t: t0, k: "down" });
  let acc = 0, freeV = 0;
  for (let ms = t0 + 1; ms <= dur * 1000; ms++) {
    let vel;
    if (ms <= t1) vel = 0;
    else if (ms <= t2) vel = (v * (ms - t1)) / (t2 - t1);
    else if (ms <= tUp) vel = v;
    else vel = v * Math.exp(-(ms - tUp) / 1000 / FREE_TAU);
    if (ms > tUp && Math.abs(vel) < 0.06) break; // the free platter has stopped
    acc += vel / 1000 / TICK;
    const n = Math.trunc(acc);
    if (n !== 0) {
      acc -= n;
      ev.push({ t: ms, k: ms <= tUp ? "tick22" : "tick21", d: Math.max(-63, Math.min(63, n)) });
    }
    if (ms === Math.round(tUp)) ev.push({ t: tUp + 0.5, k: "up" });
    freeV = vel;
  }
  if (!ev.some((e) => e.k === "up")) ev.push({ t: tUp + 0.5, k: "up" });
  ev.sort((a, b) => a.t - b.t);
  return { play, pos, dur, ev, release: tUp / 1000, v, freeV };
}
// The operator's own backspin, replayed byte for byte from the capture (touch at 6.6 s, release at
// 6781 ms, the 0x21 free spin after), on a deck playing at 1x.
function captureBackspin() {
  const cap = JSON.parse(readFileSync(new URL("../../src/htl/midi/fixtures/flx4-jog-real-2026-11-02.json", import.meta.url), "utf8"));
  const e0 = cap.events[0].t;
  const from = e0 + 6300, to = e0 + 7700;
  const ev = [];
  let release = null;
  for (const e of cap.events) {
    if (e.t < from || e.t > to) continue;
    const t = e.t - from + 800;
    if ((e.s & 0xf0) === 0x90 && e.d1 === 0x36 && (e.s & 0x0f) === 0) {
      ev.push({ t, k: e.d2 > 0 ? "down" : "up" });
      if (e.d2 === 0) release = t / 1000;
    } else if (e.s === 0xb0 && (e.d1 === 0x22 || e.d1 === 0x21)) ev.push({ t, k: e.d1 === 0x22 ? "tick22" : "tick21", d: e.d2 - 64 });
  }
  return { play: true, pos: 60, dur: 4.5, ev, release };
}
const GESTURES = {
  "fwd-1.5x": () => throwGesture({ v: 1.5, ramp: 0.06, keep: 0.25, dur: 3 }),
  "fwd-3x": () => throwGesture({ v: 3, ramp: 0.06, keep: 0.12, dur: 3 }),
  "back-3x": () => throwGesture({ v: -3, ramp: 0.06, dur: 3.5 }),
  "back-6x": () => throwGesture({ v: -6, ramp: 0.07, dur: 4 }),
  "back-10x": () => throwGesture({ v: -10, ramp: 0.08, dur: 4.5 }),
  // A classic backspin: the deck plays 1.5 s, the hand lands on it, then flings it back hard.
  "backspin-classic": () => throwGesture({ v: -13, grab: 1.5, hold: 0.18, ramp: 0.1, dur: 5.5 }),
  "backspin-capture": captureBackspin,
  // The spinback BUTTON (key / pad / FX: JogEngine.spinback at the Back spin knob's default 0.5),
  // the worklet-owned motor ramp rather than a jog release.
  "spinback-button": () => ({ play: true, pos: 60, dur: 3.5, ev: [{ t: 1000, k: "spinbackBtn" }], release: 1.0 }),
  // A paused deck pushed and let go: coasts and stops under friction (no motor).
  "paused-throw-3x": () => throwGesture({ play: false, v: 3, ramp: 0.06, keep: 0.05, dur: 3 }),
};

// ---- the worklet ------------------------------------------------------------------------------
// Probe: per-sample read speed, from whichever branch voiced the sample (it only reads state).
const PROBES = [
  ["const s = this.readScrub(c, p0, this.pos, sp);", "if (c === 0) globalThis.__spd = this.pos - p0; const s = this.readScrub(c, p0, this.pos, sp);"],
  ["const s = this.readScrub(c, rp0, this.pos, sp);", "if (c === 0) globalThis.__spd = this.curStep; const s = this.readScrub(c, rp0, this.pos, sp);"],
  ["this.pos += this.curRaw;", "this.pos += this.curRaw; globalThis.__spd = this.curRaw;"],
];
function makeWorklet() {
  let src = SCRATCH_WORKLET_SRC;
  for (const [from, to] of PROBES) if (src.includes(from)) src = src.replace(from, to);
  globalThis.sampleRate = SR;
  let Proc = null;
  globalThis.AudioWorkletProcessor = class { constructor() { this.port = { onmessage: null, postMessage() {} }; } };
  globalThis.registerProcessor = (_n, cls) => (Proc = cls);
  delete globalThis.__htlPcm;
  new Function(src)();
  globalThis.__htlPcm.set("A", { gL: [L], gR: [R], length: LEN, pcmScale: 1 });
  return new Proc({ processorOptions: { deckId: "A" } });
}

// ---- one run ----------------------------------------------------------------------------------
function run(g) {
  let simMs = 0;
  const now = () => simMs;
  Object.defineProperty(globalThis, "performance", { value: { now }, configurable: true, writable: true });
  let rafQ = [], rafId = 0;
  globalThis.requestAnimationFrame = (cb) => (rafQ.push({ id: ++rafId, cb }), rafId);
  globalThis.cancelAnimationFrame = (id) => (rafQ = rafQ.filter((r) => r.id !== id));

  const wk = makeWorklet();
  const pending = []; // worklet → main messages, delivered after the quantum
  wk.port.postMessage = (m) => pending.push(m);
  const node = { port: { onmessage: null, postMessage: (m) => wk.port.onmessage({ data: m }) } };

  // The deck: its own playback voice (plain 1x read) + the transport state JogEngine drives.
  const RATE = 1;
  const deck = { playing: g.play, startOffset: g.pos, startedAt: 0, voiceGain: g.play ? 1 : 0, voiceTarget: g.play ? 1 : 0 };
  const ctx = { get currentTime() { return simMs / 1000; }, state: "running", sampleRate: SR, resume() {} };
  const pos = () => (deck.playing ? deck.startOffset + (ctx.currentTime - deck.startedAt) * RATE : deck.startOffset);
  const host = {
    position: pos,
    startOffset: () => deck.startOffset,
    setStartOffset: (v) => { deck.startOffset = v; if (deck.playing) deck.startedAt = ctx.currentTime; },
    playing: () => deck.playing,
    setPlaying: (v) => { if (v && !deck.playing) deck.startedAt = ctx.currentTime; deck.playing = v; },
    loaded: () => true,
    duration: () => LEN / SR,
    rate: () => RATE,
    effRate: () => RATE,
    play: () => { deck.playing = true; deck.startedAt = ctx.currentTime; deck.voiceTarget = 1; },
    pause: () => { deck.startOffset = pos(); deck.playing = false; deck.voiceTarget = 0; },
    spawnSource: (at) => { deck.startOffset = at; deck.startedAt = ctx.currentTime; deck.voiceTarget = 1; deck.voiceGain = 0; },
    stopSource: () => { deck.voiceTarget = 0; deck.voiceGain = 0; },
    clearBend: () => {},
    connectScratch: () => {},
    slipArm: () => {},
    slipArmForce: () => {},
    slipReleasePos: () => null,
    loopBounds: () => null,
  };
  const je = new JogEngine(ctx, host);
  je.attachNode(node);

  // useMidiRouting's vinyl-mode jog routing (jogTouch / jogTurn scratch / jogBend + the follow).
  let touched = false, fol = null, drain = null, bendTicks = 0, handoffAt = null;
  const check = () => {
    if (!fol) return;
    if (!je.grabbing) { fol = null; return; }
    const a = follow.decideSpinFollow({ returnsToPlay: je.returnsToPlay, vel: je.handVelocity, rate: RATE, msSinceTick: now() - fol.lastTick, msSinceRelease: now() - fol.released });
    if (a === "handoff") {
      fol = null;
      if (NEW_ROUTING && je.returnsToPlay) drain = { lastTick: now() };
      handoffAt = now() / 1000;
      if (process.env.BS_DEBUG) console.log(`   [handoff ${handoffAt.toFixed(3)}] tick-fit ${je.releaseVelocity?.(now())?.toFixed(2)}x, frame-smoothed ${je.handVelocity.toFixed(2)}x`);
      je.scrubEnd();
    }
  };
  const midi = (e) => {
    if (e.k === "spinbackBtn") {
      je.spinback();
    } else if (e.k === "down") {
      touched = true;
      drain = null;
      if (fol && je.grabbing) fol = null;
      else { fol = null; je.scrubBegin(); }
    } else if (e.k === "up") {
      touched = false;
      if (je.grabbing) { fol = { released: now(), lastTick: now() }; check(); }
    } else if (e.k === "tick22") {
      if (!touched) return;
      if (!je.grabbing) je.scrubBegin();
      je.scrubMove(e.d * TICK, e.t);
    } else if (e.k === "tick21") {
      if (NEW_ROUTING && drain && now() - drain.lastTick < follow.SPIN_STILL_MS) { drain.lastTick = now(); return; }
      if (!fol && !deck.playing && !je.jogging) { je.scrubBegin(); fol = { released: now(), lastTick: now(), search: true }; }
      if (fol && je.grabbing) {
        je.scrubMove(e.d * TICK, NEW_ROUTING ? e.t : undefined);
        fol.lastTick = now();
        if (fol.search) fol.released = fol.lastTick;
        check();
        return;
      }
      if (!je.jogging && deck.playing) bendTicks++; // deck.bend: a tempo nudge (warble) on a playing deck
    }
  };

  const n = Math.ceil((g.dur * SR) / Q) * Q;
  const outL = new Float32Array(n), outR = new Float32Array(n), spd = new Float32Array(n);
  const out = [new Float32Array(Q), new Float32Array(Q)];
  const kG = 1 - Math.exp(-1 / (0.004 * SR));
  let ei = 0, nextFrame = 0, nextCheck = 0;
  for (let q = 0; q * Q < n; q++) {
    const qEnd = (((q + 1) * Q) / SR) * 1000;
    // Everything due before this quantum renders, in time order: MIDI, rAF frames, the 15 ms checker.
    for (;;) {
      const tE = ei < g.ev.length ? g.ev[ei].t : Infinity;
      const tF = nextFrame, tC = fol ? nextCheck : Infinity;
      const t = Math.min(tE, tF, tC);
      if (t > qEnd - 1000 / SR * Q) break;
      simMs = t;
      if (t === tE) midi(g.ev[ei++]);
      else if (t === tF) {
        nextFrame += 1000 / 60;
        const qq = rafQ; rafQ = [];
        for (const r of qq) r.cb(simMs);
        if (process.env.BS_DEBUG && je.jogging && !je.grabbing) console.log(`   [frame ${(simMs / 1000).toFixed(3)}] platter ${je.jogVel?.toFixed(2)}x`);
      }
      else { nextCheck = t + 15; check(); }
      if (!fol) nextCheck = Math.max(nextCheck, simMs + 15);
    }
    simMs = ((q * Q) / SR) * 1000;
    globalThis.__spd = 0;
    wk.process([], [out], {});
    for (let i = 0; i < Q; i++) {
      const s = q * Q + i;
      // The deck's own voice: plain playback at the play rate, declicked like the real crossfade.
      deck.voiceGain += (deck.voiceTarget - deck.voiceGain) * kG;
      let vl = 0, vr = 0;
      if (deck.voiceGain > 1e-4) {
        const p = Math.round((deck.startOffset + (s / SR - deck.startedAt) * RATE) * SR);
        if (p >= 0 && p < LEN) { vl = L[p] * deck.voiceGain; vr = R[p] * deck.voiceGain; }
      }
      outL[s] = out[0][i] + vl;
      outR[s] = out[1][i] + vr;
    }
    // Speed this quantum: the scratch voice's read speed while it sounds, else the deck's play rate.
    const wkOn = wk.gain > 0.5 && wk.active;
    for (let i = 0; i < Q; i++) spd[q * Q + i] = wkOn ? globalThis.__spd : deck.playing && deck.voiceGain > 0.5 ? RATE : deck.playing ? RATE : 0;
    simMs = qEnd;
    const msgs = pending.splice(0);
    for (const m of msgs) node.port.onmessage?.({ data: m });
  }
  return { outL, outR, spd, bendTicks, handoffAt };
}

// ---- output -----------------------------------------------------------------------------------
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
// The speed curve from the touch-up on: 10 ms means every 50 ms, and the landmarks.
function curve(spd, rel, play) {
  const at = (t) => { const a = Math.round((rel + t) * SR), b = Math.min(spd.length, a + Math.round(0.01 * SR)); let s = 0; for (let i = a; i < b; i++) s += spd[i]; return s / Math.max(1, b - a); };
  const pts = [];
  for (let t = 0; t <= 2.0001 && rel + t + 0.01 < spd.length / SR; t += 0.05) pts.push(at(t));
  let peak = 0, zeroAt = null, landAt = null, stopAt = null;
  for (let t = 0; rel + t + 0.01 < spd.length / SR; t += 0.002) {
    const v = at(t);
    if (Math.abs(v) > Math.abs(peak)) peak = v;
    if (zeroAt == null && t > 0 && pts[0] < 0 && v >= 0) zeroAt = t;
    if (landAt == null && play && Math.abs(v - 1) < 0.03) { let ok = true; for (let u = t; u < t + 0.1; u += 0.01) if (Math.abs(at(u) - 1) > 0.03) ok = false; if (ok) landAt = t; }
    if (stopAt == null && !play && Math.abs(v) < 0.02) stopAt = t;
  }
  return { pts, peak, zeroAt, landAt, stopAt };
}

mkdirSync(OUT, { recursive: true });
const report = {};
for (const [name, mk] of Object.entries(GESTURES)) {
  if (ONLY && !ONLY.includes(name)) continue;
  const g = mk();
  const r = run(g);
  wav(join(OUT, `${name}-${TAG}.wav`), r.outL, r.outR);
  const c = curve(r.spd, g.release, g.play);
  report[name] = { release: g.release, handoffAt: r.handoffAt, bendTicks: r.bendTicks, ...c };
  const f = (x) => (x == null ? "  -  " : x.toFixed(2));
  console.log(`\n== ${name} [${TAG}]  touch-up ${g.release.toFixed(3)} s, handoff +${f(r.handoffAt == null ? null : r.handoffAt - g.release)} s, peak ${f(c.peak)}x, crosses 0 at +${f(c.zeroAt)} s, ${g.play ? `lands on 1x at +${f(c.landAt)} s` : `stops at +${f(c.stopAt)} s`}${r.bendTicks ? `, ${r.bendTicks} free-spin ticks bent the tempo` : ""}`);
  console.log(`   speed every 50 ms from the touch-up: ${c.pts.map((v) => v.toFixed(2)).join(" ")}`);
}
if (!ONLY) writeFileSync(join(OUT, `curves-${TAG}.json`), JSON.stringify(report, null, 1));
