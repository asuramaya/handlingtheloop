import { describe, expect, it } from "vitest";
import { STRETCH_WORKLET_SRC } from "./stretchWorklet";

// Operator, 2026-11-06: "super short loops bug out … the last good sounding loop length is 1/8 but at
// 1/16 or shorter it kind of breaks". The stretch engine builds its output from grains (WSOLA: FS =
// 1024 samples ≈ 21 ms on Balanced, plus a ±200-sample search; PV: a 2048/4096 FFT frame) read
// LINEARLY from the track, and only the clock wrapped at the loop end. A 1/16 loop at 128 bpm is
// ~29 ms, so most of every grain came from audio AFTER the loop. Here: a quiet tone inside the loop,
// loud audio right after it. A loop must never let the after-audio through. Runs the real worklet.

const SR = 48000;
const Q = 128;
type W = { onMsg: (d: Record<string, unknown>) => void; process: (i: unknown[], o: Float32Array[][]) => boolean };

function make(): W {
  const g = globalThis as Record<string, unknown>;
  g.sampleRate = SR;
  let P: (new (o: unknown) => W) | null = null;
  g.AudioWorkletProcessor = class {
    port = { onmessage: null as unknown, postMessage() {} };
  };
  g.registerProcessor = (_n: string, c: new (o: unknown) => W) => (P = c);
  new Function(STRETCH_WORKLET_SRC)();
  return new P!({ processorOptions: { deckId: "A" }, numberOfOutputs: 1 });
}

const LEN = SR * 3;
const LOOP_START = 1.0;
const QUIET = 0.2;
const LOUD = 0.9;

/** Peak output while a loop of `beats` (at 128 bpm) has been running for 0.25–0.75 s. */
function loopPeak(cfg: Record<string, unknown>, beats: number): number {
  const loopLen = (60 / 128) * beats;
  const sig = new Float32Array(LEN);
  const a = Math.round(LOOP_START * SR);
  const b = Math.round((LOOP_START + loopLen) * SR);
  for (let i = 0; i < LEN; i++) sig[i] = i >= a && i < b ? QUIET * Math.sin((2 * Math.PI * 440 * i) / SR) : LOUD * (i % 2 ? 1 : -1);
  const w = make();
  w.onMsg({ type: "config", transient: true, aa: true, ...cfg });
  w.onMsg({ type: "loadPcm", gL: [sig], gR: [sig], length: LEN, int16: false });
  w.onMsg({ type: "loop", active: true, start: LOOP_START, end: LOOP_START + loopLen });
  w.onMsg({ type: "start", offset: LOOP_START });
  const o = [[new Float32Array(Q), new Float32Array(Q)]];
  let pk = 0;
  for (let n = 0; n < (SR * 0.75) / Q; n++) {
    w.process([], o);
    if (n * Q >= SR * 0.25) for (const v of o[0][0]) pk = Math.max(pk, Math.abs(v));
  }
  return pk;
}

const ENGINES: [string, Record<string, unknown>][] = [
  ["wsola balanced", { frame: 1024, search: 200, stride: 2 }],
  ["wsola hifi", { frame: 2048, search: 300, stride: 1 }],
  ["wsola fast", { frame: 512, search: 120, stride: 4 }],
  ["pv balanced", { engine: "pv", frame: 1024, search: 200, stride: 2 }],
  ["pv hifi", { engine: "pv", frame: 2048, search: 300, stride: 1 }],
];

describe("stretch worklet: a short loop plays only what is inside it", () => {
  for (const [name, cfg] of ENGINES) {
    for (const beats of [1 / 4, 1 / 8, 1 / 16, 1 / 32]) {
      it(`${name}, 1/${Math.round(1 / beats)} beat: no audio from after the loop leaks in`, () => {
        const pk = loopPeak(cfg, beats);
        expect(pk).toBeLessThan(QUIET * 1.6); // nothing from after the loop
        expect(pk).toBeGreaterThan(QUIET * 0.5); // and the loop itself still plays
      });
    }
  }
});
