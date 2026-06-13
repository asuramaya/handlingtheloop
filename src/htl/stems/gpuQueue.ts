// App-wide GPU work serializer.
//
// Stem separation (HT-Demucs) and Whisper lyric transcription are the two WebGPU consumers,
// and the browser compositor draws from that SAME physical GPU. Running two heavy WebGPU jobs
// at once thrashes occupancy (two contexts fighting for the cores) and starves the compositor,
// so the deck/waveform stutter. Funnelling BOTH through one queue means one heavy GPU job at a
// time, at full occupancy, with predictable paint gaps — the decode-once jobs finish faster in
// aggregate AND the UI stays smoother than the uncoordinated free-for-all.
//
// Deliberately NOT gated here: the CPU STFT/iSTFT that builds the waveform pyramid + beatgrid
// (it runs in the analysis worker, off both the GPU and this queue). A freshly-loaded track
// must stay instantly visible and playable while stems/lyrics wait their turn — so the track's
// own DSP always takes priority over the background GPU work.
//
// One promise chain = a concurrency-1 semaphore. A job that throws still releases the lock (the
// `.then(noop, noop)` swallows it for the NEXT job; the original rejection still reaches the
// caller of gpuRun).
let chain: Promise<unknown> = Promise.resolve();

export function gpuRun<T>(job: () => Promise<T>): Promise<T> {
  const run = chain.then(job, job);
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
