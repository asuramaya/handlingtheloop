import { describe, expect, it } from "vitest";
import { STRETCH_WORKLET_SRC } from "./stretchWorklet";

// FREEZE (FX2, operator 2026-11-07): the stretch engine keeps reading grains from one instant, so
// the sound holds as a drone. A quiet tone up to 1.0 s, loud audio after it; start at 0.9 s and
// freeze at once. Playing on, the loud part arrives within 100 ms; frozen, it never must.
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
const sig = new Float32Array(LEN);
for (let i = 0; i < LEN; i++) sig[i] = i < SR ? 0.2 * Math.sin((2 * Math.PI * 440 * i) / SR) : 0.9 * (i % 2 ? 1 : -1);

function peak(cfg: Record<string, unknown>, freeze: boolean, thaw = false): { held: number; after: number } {
  const w = make();
  w.onMsg({ type: "config", transient: true, aa: true, ...cfg });
  w.onMsg({ type: "loadPcm", gL: [sig], gR: [sig], length: LEN, int16: false });
  w.onMsg({ type: "start", offset: 0.9 });
  if (freeze) w.onMsg({ type: "freeze", on: true, spray: 0.03 });
  const o = [[new Float32Array(Q), new Float32Array(Q)]];
  let held = 0, after = 0;
  for (let n = 0; n < (SR * 0.6) / Q; n++) {
    w.process([], o);
    if (n * Q > SR * 0.05) for (const v of o[0][0]) held = Math.max(held, Math.abs(v));
  }
  if (thaw) {
    w.onMsg({ type: "freeze", on: false });
    w.onMsg({ type: "seek", offset: 1.5 }); // Deck re-seats on its running clock
    for (let n = 0; n < (SR * 0.2) / Q; n++) {
      w.process([], o);
      for (const v of o[0][0]) after = Math.max(after, Math.abs(v));
    }
  }
  return { held, after };
}

describe("stretch worklet: FREEZE holds one instant", () => {
  for (const [name, cfg] of [
    ["wsola", { frame: 1024, search: 200, stride: 2 }],
    ["pv", { engine: "pv", frame: 1024, search: 200, stride: 2 }],
  ] as const) {
    it(`${name}: CONTROL — unfrozen, the loud part arrives`, () => {
      expect(peak(cfg, false).held).toBeGreaterThan(0.6);
    });
    it(`${name}: frozen at 0.9 s, the sound stays on the quiet tone and keeps sounding`, () => {
      const { held } = peak(cfg, true);
      expect(held).toBeLessThan(0.35);
      expect(held).toBeGreaterThan(0.05);
    });
    it(`${name}: thawed with a re-seat, playback lands on the running clock (the loud part)`, () => {
      expect(peak(cfg, true, true).after).toBeGreaterThan(0.6);
    });
  }
});
