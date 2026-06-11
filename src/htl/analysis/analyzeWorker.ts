// Client side of the analysis worker: post an AudioBuffer's channels, await the
// TrackAnalysis. Degrades gracefully — if the worker can't be constructed or dies
// mid-flight, analysis runs inline on the main thread so a track still loads.
import { analyzeChannels } from "./analyze";
import type { TrackAnalysis } from "./analyze";

let worker: Worker | null = null;
let failed = false; // construction failed once → don't keep retrying, go inline
let seq = 0;
type Pending = { resolve: (a: TrackAnalysis) => void; reject: (e: unknown) => void };
const pending = new Map<number, Pending>();

function getWorker(): Worker | null {
  if (worker || failed) return worker;
  try {
    worker = new Worker(new URL("./analysis.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<{ id: number; analysis?: TrackAnalysis; error?: string }>) => {
      const { id, analysis, error } = e.data;
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      if (error || !analysis) p.reject(new Error(error ?? "analysis failed"));
      else p.resolve(analysis);
    };
    worker.onerror = () => {
      // Reject everything in flight; each call's .catch falls back inline.
      for (const [id, p] of pending) {
        pending.delete(id);
        p.reject(new Error("analysis worker error"));
      }
    };
    return worker;
  } catch {
    failed = true;
    worker = null;
    return null;
  }
}

/** Analyse `buffer` off-thread. Channels are COPIED (slice) before transfer so the
 *  live playback buffer is never detached. */
export function analyzeTrackAsync(buffer: AudioBuffer): Promise<TrackAnalysis> {
  const sampleRate = buffer.sampleRate;
  const inline = (): TrackAnalysis => {
    const c0 = buffer.getChannelData(0).slice();
    const c1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1).slice() : null;
    return analyzeChannels(c0, c1, sampleRate);
  };

  const w = getWorker();
  if (!w) return Promise.resolve(inline());

  const ch0 = buffer.getChannelData(0).slice();
  const ch1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1).slice() : null;
  const id = ++seq;
  return new Promise<TrackAnalysis>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    const transfer: Transferable[] = ch1 ? [ch0.buffer, ch1.buffer] : [ch0.buffer];
    w.postMessage({ id, ch0, ch1, sampleRate }, transfer);
  }).catch(() => inline()); // worker died — recopy from the intact source buffer
}
