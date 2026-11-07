import { describe, expect, it } from "vitest";
import { SCRATCH_WORKLET_SRC } from "./scratchWorklet";

// Operator, 2026-11-02: micro jogs "feel laggy on first touch". Measured on this worklet before the
// fix: a 1-4 tick FLX4 nudge from a still platter took 35-48 ms to cover HALF its travel, because
// the first tick was banked until the next ~60 Hz settle post and then chased over that interval.
// Runs the real worklet source under minimal AudioWorkletGlobalScope shims.

const SR = 48000;
const Q = 128;
const TICK = 0.0025 * SR;

type Node = { port: { onmessage: (e: { data: unknown }) => void }; process: (i: unknown[], o: Float32Array[][]) => boolean; pos: number };

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

/** Grab, hold still with 60 Hz settle posts, then `n` ticks `spacingMs` apart. Returns ms (after
 *  the first tick) until the read head has covered `frac` of the nudge. */
function onsetMs(n: number, spacingMs: number, frac: number): number {
  const w = make();
  const post = (m: Record<string, unknown>) => w.port.onmessage({ data: m });
  const out = [new Float32Array(Q), new Float32Array(Q)];
  const msQ = (Q / SR) * 1000;
  const p0 = 5 * SR;
  const still = 120;
  const sched: Array<{ t: number; pos: number; start?: boolean }> = [{ t: 0, pos: p0, start: true }];
  for (let f = 16.7; f < still; f += 16.7) sched.push({ t: f, pos: p0 });
  for (let k = 1; k <= n; k++) sched.push({ t: still + (k - 1) * spacingMs, pos: p0 + k * TICK });
  const end = still + (n - 1) * spacingMs;
  for (let f = end + 16.7; f < end + 200; f += 16.7) sched.push({ t: f, pos: p0 + n * TICK });
  let last = -1;
  let mi = 0;
  for (let t = 0; t < end + 200; t += msQ) {
    while (mi < sched.length && sched[mi].t <= t) {
      const s = sched[mi++];
      if (s.start) post({ type: "start", pos: s.pos });
      else {
        post({ type: "move", pos: s.pos, dtMs: last >= 0 ? s.t - last : 0 });
        last = s.t;
      }
    }
    w.process([], [out]);
    if (t >= still && w.pos - p0 >= n * TICK * frac) return t - still;
  }
  return Infinity;
}

describe("scratch worklet: a nudge from a still platter answers at once", () => {
  it.each([
    [1, 0],
    [3, 1],
    [4, 3],
  ])("%i tick(s) %i ms apart: half the travel inside ~15 ms (was 35-48 ms)", (n, sp) => {
    expect(onsetMs(n, sp, 0.5)).toBeLessThan(15);
  });

  it("CONTROL: and it still arrives (no overshoot runaway): the full nudge is covered within 60 ms", () => {
    expect(onsetMs(4, 3, 0.95)).toBeLessThan(60);
  });
});
