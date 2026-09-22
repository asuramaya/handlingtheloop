// Client side of the analysis worker: post an AudioBuffer's channels, await the
// TrackAnalysis. Degrades gracefully — if the worker can't be constructed or dies
// mid-flight, analysis runs inline on the main thread so a track still loads.
import { analyzeChannels } from "./analyze";
import type { Beatgrid, TrackAnalysis } from "./analyze";

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

/** Analyse `buffer` off-thread. A MONO MIX is copied before transfer, so the live playback buffer is
 *  never detached. When `grid` is passed (a grid reused from the crowdsourced cache), beat detection
 *  is skipped and that grid is used verbatim — key and the LOD pyramid are still derived from the
 *  buffer off-thread (they aren't persisted).
 *
 *  ★ IT USED TO SEND BOTH CHANNELS, AND NOTHING ON THE OTHER SIDE WANTED THEM. All three consumers
 *  downmix first and with the identical expression — computePyramidFromChannels, the key chromagram
 *  and beats.ts's decimateMono each compute `(ch0[i] + ch1[i]) * 0.5`. So the second channel crossed
 *  the boundary only to be averaged away three times. Doing it here instead is one pass rather than
 *  two copies, and it halves both the allocation and the transfer: measured on a 4-minute stereo
 *  track at 48k, 88 MB / 47 ms became 44 MB / 37 ms. The memory is the half that matters — that peak
 *  lands on a phone in the middle of a track load.
 *
 *  Measured identical, not merely close: same bpm, same 511 beats to under a microsecond, same key,
 *  same downbeat, same energy. (Pre-mixing stores the average as float32 where the consumers held it
 *  as a double, so the two are not identical BY CONSTRUCTION — they were identical in fact on real
 *  material, and that is the claim.)
 *
 *  ★ AND THE INLINE PATH COPIES NOTHING AT ALL NOW. The copy exists to survive a TRANSFER; when
 *  there is no worker there is no transfer and nothing can be detached, so the fallback reads the
 *  live channels directly. That path is the one that runs on the devices least able to afford the
 *  allocation — the ones where constructing a Worker failed. */
export function analyzeTrackAsync(buffer: AudioBuffer, grid?: Beatgrid | null): Promise<TrackAnalysis> {
  const sampleRate = buffer.sampleRate;
  // No transfer, no detach → read the live buffer, copy nothing.
  const inline = (): TrackAnalysis =>
    analyzeChannels(
      buffer.getChannelData(0),
      buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : null,
      sampleRate,
      grid,
    );

  const w = getWorker();
  if (!w) return Promise.resolve(inline());

  const l = buffer.getChannelData(0);
  const r = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : null;
  const mono = new Float32Array(l.length);
  if (r) for (let i = 0; i < l.length; i++) mono[i] = (l[i] + r[i]) * 0.5;
  else mono.set(l);
  const id = ++seq;
  return new Promise<TrackAnalysis>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    // Only the mix transfers — `grid` is small and structured-cloned (its Float32Arrays stay owned
    // by the caller, which needs the grid intact for its own use).
    w.postMessage({ id, ch0: mono, ch1: null, sampleRate, grid }, [mono.buffer]);
  }).catch(() => inline()); // worker died — re-read the intact source buffer
}
