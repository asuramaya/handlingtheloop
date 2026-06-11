/// <reference lib="webworker" />
// Offline track analysis (beatgrid + key + LOD pyramid) off the main thread. The
// DP beat tracker + STFT cost ~0.5 s for a long track — synchronous on the main
// thread that's a visible UI stall on every load. The worker receives raw channel
// arrays (no AudioBuffer exists here) and returns the full TrackAnalysis.
import { analyzeChannels } from "./analyze";
import type { TrackAnalysis } from "./analyze";

interface Req {
  id: number;
  ch0: Float32Array;
  ch1: Float32Array | null;
  sampleRate: number;
}

const ctx = self as unknown as Worker;

ctx.onmessage = (e: MessageEvent<Req>) => {
  const { id, ch0, ch1, sampleRate } = e.data;
  try {
    const analysis: TrackAnalysis = analyzeChannels(ch0, ch1, sampleRate);
    ctx.postMessage({ id, analysis });
  } catch (err) {
    ctx.postMessage({ id, error: String((err as Error)?.message ?? err) });
  }
};
