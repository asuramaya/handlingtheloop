// Main-thread orchestrator for the demucs-rs (WebGPU) engine. Keeps a single
// worker, serializes jobs (one separation at a time), and slices the returned
// audio into our `Stems` shape. demucs-rs resamples to/from 44.1 kHz internally,
// so the stems come back at the mix's own rate/length.
import { STEM_NAMES, type Stems } from "./index";
import type { StemModel } from "./models";

let worker: Worker | null = null;
let jobId = 0;
interface Job {
  resolve: (v: { audio: Float32Array; nSamples: number; numStems: number; names: string[] }) => void;
  reject: (e: Error) => void;
  onProgress?: (pct: number) => void;
}
const jobs = new Map<number, Job>();

/* eslint-disable @typescript-eslint/no-explicit-any */
function progressPct(ev: any): number {
  return ev && (ev.type === "chunk_done" || ev.type === "chunk_started") && ev.total ? ev.index / ev.total : 0;
}

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL("./demucs.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent) => {
      const { type, id } = e.data;
      const job = jobs.get(id);
      if (!job) return;
      if (type === "progress") job.onProgress?.(progressPct(e.data.event));
      else if (type === "done") {
        jobs.delete(id);
        job.resolve(e.data);
      } else if (type === "error") {
        jobs.delete(id);
        job.reject(new Error(e.data.message));
      }
    };
    worker.onerror = (e) => {
      const msg = new Error(e.message || "demucs worker crashed");
      for (const [id, job] of jobs) {
        jobs.delete(id);
        job.reject(msg);
      }
    };
  }
  return worker;
}

let chain: Promise<unknown> = Promise.resolve();
export function separateDemucs(mix: AudioBuffer, model: StemModel, onProgress?: (pct: number) => void): Promise<Stems> {
  const run = chain.then(
    () => separateInner(mix, model, onProgress),
    () => separateInner(mix, model, onProgress),
  );
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function separateInner(mix: AudioBuffer, model: StemModel, onProgress?: (pct: number) => void): Promise<Stems> {
  if (!model.url || !model.wasmModel) throw new Error("demucs model misconfigured (need url + wasmModel)");
  const left = mix.getChannelData(0).slice();
  const right = (mix.numberOfChannels > 1 ? mix.getChannelData(1) : mix.getChannelData(0)).slice();

  const id = ++jobId;
  const w = getWorker();
  const res = await new Promise<{ audio: Float32Array; nSamples: number; numStems: number; names: string[] }>(
    (resolve, reject) => {
      jobs.set(id, { resolve, reject, onProgress });
      w.postMessage(
        {
          type: "separate",
          id,
          weightsUrl: model.url,
          wasmModel: model.wasmModel,
          left: left.buffer,
          right: right.buffer,
          sampleRate: mix.sampleRate,
        },
        [left.buffer, right.buffer],
      );
    },
  );

  const { audio, nSamples, numStems, names } = res;
  const out = {} as Stems;
  for (let i = 0; i < numStems; i++) {
    const name = names[i] as (typeof STEM_NAMES)[number];
    if (!STEM_NAMES.includes(name)) continue;
    const off = i * 2 * nSamples;
    const buf = new AudioBuffer({ length: nSamples, sampleRate: mix.sampleRate, numberOfChannels: 2 });
    buf.copyToChannel(audio.subarray(off, off + nSamples) as Float32Array<ArrayBuffer>, 0);
    buf.copyToChannel(audio.subarray(off + nSamples, off + 2 * nSamples) as Float32Array<ArrayBuffer>, 1);
    out[name] = buf;
  }
  return out;
}
