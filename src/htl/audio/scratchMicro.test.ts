import { describe, expect, it } from "vitest";
import { SCRATCH_WORKLET_SRC } from "./scratchWorklet";

// Operator, 2026-11-03: micro jogs "still need work for the slurry feel and sound". Measured on this
// worklet before the fix: after a 1-16 tick nudge from a still platter the read head ran 23-59% of
// the nudge PAST where the hand stopped, then slid back, settling only after 110-190 ms. The fix
// (ARRIVAL STOP) lands a micro jog on the hand and stops it there, and must leave ordinary
// scratching alone: the full comparison is scripts/joglab/microjog.mjs + scratchreplay.mjs.
// Runs the real worklet source under minimal AudioWorkletGlobalScope shims.

const SR = 48000;
const Q = 128;
const TICK = 0.0025 * SR;

type Node = { port: { onmessage: (e: { data: unknown }) => void }; process: (i: unknown[], o: Float32Array[][]) => boolean; pos: number; curStep: number };

function make(): Node {
  const g = globalThis as Record<string, unknown>;
  g.sampleRate = SR;
  let P: (new (o: unknown) => Node) | null = null;
  g.AudioWorkletProcessor = class {
    port = { onmessage: null as unknown, postMessage() {} };
  };
  g.registerProcessor = (_n: string, c: new (o: unknown) => Node) => (P = c);
  delete g.__htlPcm;
  new Function(SCRATCH_WORKLET_SRC)();
  const LEN = SR * 30;
  const tone = new Float32Array(LEN).map((_, i) => Math.sin(i / 20) * 0.5);
  (g.__htlPcm as Map<string, unknown>).set("A", { gL: [tone], gR: [tone], length: LEN, pcmScale: 1 });
  return new P!({ processorOptions: { deckId: "A" } });
}

type Msg = { t: number; pos: number; start?: boolean; hw?: boolean };

/** Drive the worklet through a schedule; returns the read head per `sub` samples (messages still
 *  land only between 128-sample render quanta, as a MessagePort delivers them). A `hw` move is a
 *  controller tick: it carries its own timestamp and hw: true, as JogEngine posts one. */
function drive(sched: Msg[], untilMs: number, sub = Q): Array<{ t: number; pos: number }> {
  const w = make();
  const post = (m: Record<string, unknown>) => w.port.onmessage({ data: m });
  const out = [new Float32Array(sub), new Float32Array(sub)];
  const msQ = (Q / SR) * 1000;
  sched.sort((a, b) => a.t - b.t);
  const trace: Array<{ t: number; pos: number }> = [];
  let last = -1;
  let mi = 0;
  for (let t = 0; t < untilMs; t += msQ) {
    while (mi < sched.length && sched[mi].t <= t) {
      const s = sched[mi++];
      if (s.start) post({ type: "start", pos: s.pos });
      else {
        post({ type: "move", pos: s.pos, dtMs: last >= 0 ? s.t - last : 0, ...(s.hw ? { ts: s.t, hw: true } : {}) });
        last = s.t;
      }
    }
    for (let k = 0; k < Q / sub; k++) {
      w.process([], [out]);
      trace.push({ t: t + (k * sub * 1000) / SR, pos: w.pos }); // pos after the block that starts at t
    }
  }
  return trace;
}

/** Grab, hold still (60 Hz settle posts), `n` ticks over `durMs`, hold again. */
function nudge(n: number, durMs: number, hw = false) {
  const p0 = 5 * SR;
  const end = p0 + n * TICK;
  const sched: Msg[] = [{ t: 0, pos: p0, start: true }];
  for (let f = 16.7; f < 60; f += 16.7) sched.push({ t: f, pos: p0 });
  for (let k = 1; k <= n; k++) sched.push({ t: 60 + Math.round((durMs * k) / n), pos: p0 + k * TICK, hw });
  const tLast = 60 + durMs;
  for (let f = tLast + 16.7; f < tLast + 250; f += 16.7) sched.push({ t: f, pos: end });
  const trace = drive(sched, tLast + 250);
  const after = trace.filter((s) => s.t > tLast);
  const overrun = Math.max(0, ...trace.map((s) => s.pos - end));
  const settled = after.find((s, i) => Math.abs(s.pos - end) < 1 && after.slice(i).every((x) => Math.abs(x.pos - end) < 1));
  return { overrunMs: (overrun / SR) * 1000, settleMs: settled ? settled.t - tLast : Infinity };
}

describe("micro jog: the read head stops where the hand stops", () => {
  for (const [n, ms] of [[1, 1], [4, 10], [8, 20], [8, 60], [16, 40]] as const) {
    it(`${n} ticks over ${ms} ms: no overrun past the hand, settled within 25 ms`, () => {
      const r = nudge(n, ms);
      expect(r.overrunMs).toBeLessThan(0.05);
      expect(r.settleMs).toBeLessThan(25);
    });
  }

  it("a slow, steady paused-ring turn glides instead of stop-go", () => {
    // Operator, 2026-11-03: the paused outer ring is "kind of choppy". A tick every 35 ms (0.07×),
    // with grabTick's settle posts between ticks (no input for > 6 ms → re-post at the frame).
    // Before: the head parked 47% of the turn; each tick was covered in 13 ms and then waited.
    const p0 = 5 * SR;
    const sched: Msg[] = [{ t: 0, pos: p0, start: true }];
    const ticks: number[] = [];
    for (let t = 50; t <= 450; t += 35) ticks.push(t);
    ticks.forEach((t, k) => sched.push({ t, pos: p0 + (k + 1) * TICK }));
    for (let f = 16.7; f < 600; f += 16.7) {
      let k = 0;
      while (k < ticks.length && ticks[k] <= f) k++;
      if ((k === 0 ? f : f - ticks[k - 1]) > 6) sched.push({ t: f, pos: p0 + k * TICK });
    }
    const trace = drive(sched, 600);
    const turning = trace.filter((s) => s.t > 120 && s.t < 450);
    let parked = 0;
    for (let i = 1; i < turning.length; i++) if (Math.abs(turning[i].pos - turning[i - 1].pos) < 0.1 * (TICK / 35) * ((Q / SR) * 1000)) parked++;
    expect(parked / turning.length).toBeLessThan(0.12);
  });

  it("does not stall an ordinary 60 Hz drag (the stop is scoped to micro jogs)", () => {
    // touch-shaped: a still grab, then a steady 0.35x drag reported every 16.7 ms for 1 s
    const p0 = 5 * SR;
    const sched: Msg[] = [{ t: 0, pos: p0, start: true }];
    for (let f = 16.7; f < 60; f += 16.7) sched.push({ t: f, pos: p0 });
    for (let t = 60 + 16.7; t < 1060; t += 16.7) sched.push({ t, pos: p0 + ((t - 60) / 1000) * 0.35 * SR });
    const trace = drive(sched, 1060);
    // after the drag has left the micro span (~170 ms of hand travel at 0.35x), the head must keep
    // moving: no quantum parked at zero speed
    const steady = trace.filter((s) => s.t > 300 && s.t < 1040);
    let parked = 0;
    for (let i = 1; i < steady.length; i++) if (Math.abs(steady[i].pos - steady[i - 1].pos) < 1) parked++;
    expect(parked).toBe(0);
  });
});

// Operator, 2026-11-10: controller micro jogs sounded like "little raygun pew pews... R2D2 bird
// whines... smeary and low pitch", and the ask was physical parity: N ticks of hand travel play
// exactly those N x 2.5 ms of audio over the time the finger took. Before (HAND TRAJECTORY in the
// worklet) every nudge from rest was paced over a fixed ~13 ms: a 2-4 tick flick at ~2.5x played as a
// flat 0.37-0.72x plateau. These drive controller ticks (own timestamps, hw: true).
describe("controller micro jog: the head plays the hand's own trajectory", () => {
  const SUB = 16; // read the head every 16 samples (1/3 ms)
  function flick(n: number, gapMs: number) {
    const p0 = 5 * SR;
    const t1 = 60;
    const sched: Msg[] = [{ t: 0, pos: p0, start: true }];
    for (let f = 16.7; f < t1; f += 16.7) sched.push({ t: f, pos: p0 });
    for (let k = 1; k <= n; k++) sched.push({ t: t1 + (k - 1) * gapMs, pos: p0 + k * TICK, hw: true });
    const tLast = t1 + (n - 1) * gapMs;
    for (let f = tLast + 16.7; f < tLast + 200; f += 16.7) sched.push({ t: f, pos: p0 + n * TICK });
    const tr = drive(sched, tLast + 200, SUB);
    const end = p0 + n * TICK;
    const speed = tr.slice(1).map((s, i) => ({ t: s.t, v: (s.pos - tr[i].pos) / SUB }));
    const moving = speed.filter((s) => Math.abs(s.v) > 1e-4);
    return {
      peak: Math.max(...speed.map((s) => s.v)),
      movingSpeeds: moving.map((s) => s.v),
      stopAfterLastMs: moving.at(-1)!.t + (SUB / SR) * 1000 - tLast,
      overrun: Math.max(0, ...tr.map((s) => s.pos - end)),
      finalErr: Math.abs(tr.at(-1)!.pos - end),
    };
  }

  it("a 3-tick flick 1 ms apart plays at hand speed (>= 1.5x) and is done within 6 ms of the last tick", () => {
    const r = flick(3, 1);
    expect(r.peak).toBeGreaterThanOrEqual(1.5);
    expect(r.stopAfterLastMs).toBeLessThan(6);
    expect(r.overrun).toBe(0);
    expect(r.finalErr).toBeLessThan(1e-6);
  });

  it("a slow 3-tick nudge 10 ms apart plays at ~0.25x and ends exactly on the last tick", () => {
    const r = flick(3, 10);
    const sorted = [...r.movingSpeeds].sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1];
    expect(median).toBeGreaterThan(0.2);
    expect(median).toBeLessThan(0.3);
    expect(r.peak).toBeLessThan(0.35);
    expect(r.overrun).toBe(0);
    expect(r.finalErr).toBeLessThan(1e-6);
  });

  for (const [n, ms] of [[1, 1], [4, 10], [8, 20], [8, 60], [16, 40]] as const) {
    it(`${n} ticks over ${ms} ms: no overrun, settled within 25 ms`, () => {
      const r = nudge(n, ms, true);
      expect(r.overrunMs).toBe(0);
      expect(r.settleMs).toBeLessThan(25);
    });
  }
});
