// App-wide GPU work serializer.
//
// Stem separation (HT-Demucs) is the WebGPU consumer, and the browser compositor draws from
// that SAME physical GPU. Running two heavy WebGPU jobs at once (two decks separating, or a
// dev StrictMode double-fire) thrashes occupancy (two contexts fighting for the cores) and
// starves the compositor, so the deck/waveform stutter. Funnelling separation through one
// queue means one heavy GPU job at a time, at full occupancy, with predictable paint gaps —
// the decode-once jobs finish faster in aggregate AND the UI stays smoother than the
// uncoordinated free-for-all. (Lyrics alignment is CPU-only DSP now — see analyze.worker.ts —
// and doesn't touch this queue.)
//
// Deliberately NOT gated here: the CPU STFT/iSTFT that builds the waveform pyramid + beatgrid
// (it runs in the analysis worker, off both the GPU and this queue). A freshly-loaded track
// must stay instantly visible and playable while stems wait their turn — so the track's own
// DSP always takes priority over the background GPU work.
//
// One promise chain = a concurrency-1 semaphore. A job that throws still releases the lock (the
// `.then(noop, noop)` swallows it for the NEXT job; the original rejection still reaches the
// caller of gpuRun).
let chain: Promise<unknown> = Promise.resolve();

// ── THE QUIET WINDOW ────────────────────────────────────────────────────────────────────────
//
// Serialising to one job at a time stops two separations fighting each other. It does NOT stop
// ONE separation from starving the compositor — that is the same GPU, and one HT-Demucs window
// is enough on its own. Usually nobody minds: a paint gap during steady-state playback is
// invisible, because nothing on screen is moving fast enough for a dropped frame to read.
//
// A TRANSITION is the exception, and it is the worst possible one. Two waveforms scroll, the
// crossfader sweeps, EQ and stem gains ramp every 150 ms tick — the one moment the eye is
// tracking continuous motion, and the one moment AUTO is most likely to be separating, because
// `ensurePreload` fires the incoming track's separation the instant the deck is armed. Worse,
// `STEM_WAIT_MAX` makes the mixer WAIT at mix-out for stems that haven't landed, so a slow
// separation doesn't just overlap the mix, it holds the mix open until it finishes.
//
// So the queue takes a second input: a HOLD, raised by the auto-mixer across the transition
// window. While held, no NEW job starts. An in-flight job is left alone — WebGPU work cannot be
// preempted, and killing it would throw away minutes of compute to save a few hundred ms of
// jank — so the hold is a "don't start" rule, not a "stop" rule. The transition after this one
// is the one that gets the smooth ride, and every transition from then on.
//
// Deliberately a COUNTER, not a boolean: the mixer raises it per transition, and a second
// raiser (a future pre-warm pass, a manual gesture) must not be able to lower it out from under
// the first. Balanced release is the caller's job; `gpuHeld()` exists so a stuck hold is
// visible rather than silently starving stems forever.
let holds = 0;
let waiters: Array<() => void> = [];

export function holdGpu(): () => void {
  holds++;
  let released = false;
  return () => {
    if (released) return; // idempotent — a release called twice must not free someone else's hold
    released = true;
    if (--holds <= 0) {
      holds = 0;
      const w = waiters;
      waiters = [];
      for (const r of w) r();
    }
  };
}

/** True while heavy GPU work is being deferred. For diagnostics and the stem trace. */
export function gpuHeld(): boolean {
  return holds > 0;
}

function whenClear(): Promise<void> {
  if (holds <= 0) return Promise.resolve();
  return new Promise<void>((r) => waiters.push(r));
}

export function gpuRun<T>(job: () => Promise<T>): Promise<T> {
  // The hold is checked INSIDE the chain, not before it: a job that queued while the GPU was
  // free must still wait if a hold went up while it sat behind another job. Checking on the way
  // in would let exactly the job we care about — the one queued just before a transition —
  // through.
  const gated = () => whenClear().then(job);
  const run = chain.then(gated, gated);
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
