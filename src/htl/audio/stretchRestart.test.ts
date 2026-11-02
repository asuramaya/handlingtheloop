import { describe, expect, it } from "vitest";
import { STRETCH_WORKLET_SRC } from "./stretchWorklet";

// Operator, 2026-11-02, on a PV / Hi-Fi stretch setting: micro jogs "sound slurry". A playing deck
// re-seats the stretch worklet on every jog release, and the phase vocoder's overlap-add started
// EMPTY there: a click 10 ms after the seat came out 88 ms late at ~1% of its level (hifi). WSOLA
// was fine. The fix pre-rolls the PV analysis and skips the warm-up. Runs the real worklet source.

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

const LEN = SR * 4;
const sig = new Float32Array(LEN);
for (let t = 0; t < LEN; t += SR / 4) for (let k = 0; k < 48; k++) sig[t + k] = Math.exp(-k / 8) * (k % 2 ? -0.9 : 0.9);

/** Peak output level within ±10 ms of where a click 10 ms after the re-seat belongs. */
function clickPeakAfterRestart(cfg: Record<string, unknown>): number {
  const w = make();
  w.onMsg({ type: "config", transient: true, aa: true, ...cfg });
  w.onMsg({ type: "loadPcm", gL: [sig], gR: [sig], length: LEN, int16: false });
  w.onMsg({ type: "start", offset: 1.24 }); // the click at 1.25 s is 10 ms after the seat
  const o = [[new Float32Array(Q), new Float32Array(Q)]];
  const out: number[] = [];
  for (let i = 0; i < (SR * 0.1) / Q; i++) {
    w.process([], o);
    out.push(...o[0][0]);
  }
  const at = 0.01 * SR;
  let pk = 0;
  for (let i = at - 0.01 * SR; i < at + 0.01 * SR; i++) pk = Math.max(pk, Math.abs(out[i] ?? 0));
  return pk;
}

describe("stretch worklet: playback right after a re-seat is not smeared", () => {
  it.each([
    ["pv hifi", { engine: "pv", frame: 2048, search: 300, stride: 1 }],
    ["pv balanced", { engine: "pv", frame: 1024, search: 200, stride: 2 }],
  ])("%s: a click 10 ms after the seat arrives on time at most of its level (was ~1-12%%)", (_n, cfg) => {
    expect(clickPeakAfterRestart(cfg)).toBeGreaterThan(0.6);
  });

  it("CONTROL: WSOLA, which never had the warm-up, is unchanged", () => {
    expect(clickPeakAfterRestart({ frame: 1024, search: 200, stride: 2 })).toBeGreaterThan(0.6);
  });
});
