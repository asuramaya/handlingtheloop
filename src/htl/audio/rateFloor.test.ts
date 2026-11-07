import { describe, expect, it } from "vitest";
import { ENGINE_RATE_MAX, ENGINE_RATE_MIN, STRETCH_WORKLET_SRC } from "./stretchWorklet";
import { clampEngineRate } from "./Deck";

// Operator, 2026-11-03: "when i slow down all the way to the limit it breaks and pauses visual but
// song keeps playing at normal speed". With the ±100% tempo range the fader's bottom is rate 0:
// the deck clock ran at 0 (frozen visuals) while the worklet read `0 || 1` and played at 1.
// Runs the real worklet source.

type W = { onMsg: (d: Record<string, unknown>) => void; speedTarget: number; pitchTarget: number };

function make(): W {
  const g = globalThis as Record<string, unknown>;
  g.sampleRate = 48000;
  let P: (new (o: unknown) => W) | null = null;
  g.AudioWorkletProcessor = class {
    port = { onmessage: null as unknown, postMessage() {} };
  };
  g.registerProcessor = (_n: string, c: new (o: unknown) => W) => (P = c);
  new Function(STRETCH_WORKLET_SRC)();
  return new P!({ processorOptions: { deckId: "A" }, numberOfOutputs: 1 });
}

describe("tempo at the bottom of the fader", () => {
  it("the worklet plays a speed of 0 at its slowest rate, not at normal speed", () => {
    const w = make();
    w.onMsg({ type: "speed", value: 0 });
    expect(w.speedTarget).toBe(ENGINE_RATE_MIN);
    w.onMsg({ type: "pitch", value: 0 });
    expect(w.pitchTarget).toBe(ENGINE_RATE_MIN);
  });

  it("a missing value still means 1", () => {
    const w = make();
    w.onMsg({ type: "speed", value: 0.5 });
    w.onMsg({ type: "speed" });
    expect(w.speedTarget).toBe(1);
  });

  it("the deck clock runs at exactly the rate the worklet will play, at every fader position", () => {
    const w = make();
    for (const tempoPct of [-100, -90, -80, -75, -50, -8, 0, 8, 50, 100, 400]) {
      const clock = clampEngineRate(1 + tempoPct / 100);
      w.onMsg({ type: "speed", value: clock });
      expect(w.speedTarget).toBeCloseTo(clock, 12);
    }
  });

  it("clamps to the engine's range and never returns NaN", () => {
    expect(clampEngineRate(0)).toBe(ENGINE_RATE_MIN);
    expect(clampEngineRate(-1)).toBe(ENGINE_RATE_MIN);
    expect(clampEngineRate(9)).toBe(ENGINE_RATE_MAX);
    expect(clampEngineRate(Number.NaN)).toBe(1);
    expect(clampEngineRate(0.92)).toBe(0.92);
  });
});
