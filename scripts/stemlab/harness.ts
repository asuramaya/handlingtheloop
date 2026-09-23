// STEMLAB harness — runs the REAL encodeStemOpus/decodeStemOpus in a page, and measures what the
// main thread was doing while they ran. Not a reimplementation: the only knob moved between the
// two runs is decodeStemOpus's own slice budget.
import { encodeStemOpus, decodeStemOpus } from "../../src/htl/stems/opus";

// ★ MEASURE THE BACKLOG, NOT ITS SHADOW. The sweep died as a shape: interleaved, the worst gap is
// flat in the slice budget (443/448/450 ms across a 16x range) and steps only between "some sleep"
// and "no sleep". So the mechanism has to explain a STEP, and neither yield-count nor chunk-size
// does. Metron's surviving reading is backpressure: decodeStemOpus is ALREADY async and already
// awaits the decoder, so breathe() does not add yielding — it adds LATENCY between our consumption
// steps, the native decoder runs on while we sleep, and the backlog drains in a burst.
//
// Inferring that from task lengths is reading the shadow. The decoder tells us directly if we ask:
// wrap the output callback and timestamp every delivered frame. A burst is then a run of frames
// delivered with no gap between them, and backpressure predicts the sliced runs carry bursts that
// the unsliced one does not — whatever the budget.
interface Delivery {
  bursts: number;
  maxBurst: number;
  meanBurst: number;
  frames: number;
}

/** Wrap globalThis.AudioDecoder so every delivered frame is timestamped. Returns the reader. */
function watchDeliveries(): () => Delivery {
  const g = globalThis as unknown as { AudioDecoder: new (i: { output: (d: unknown) => void; error: (e: Error) => void }) => unknown };
  const Real = g.AudioDecoder;
  const at: number[] = [];
  g.AudioDecoder = class {
    constructor(init: { output: (d: unknown) => void; error: (e: Error) => void }) {
      const wrapped = { ...init, output: (d: unknown) => { at.push(performance.now()); init.output(d); } };
      return new Real(wrapped) as object;
    }
  } as unknown as typeof Real;
  return () => {
    g.AudioDecoder = Real;
    // A BURST is frames delivered with no task boundary between them. 2 ms is generous: a task
    // boundary at 4x CPU is never under that, and two frames of real decode work never that close.
    const GAP_MS = 2;
    const sizes: number[] = [];
    let n = 0;
    for (let i = 0; i < at.length; i++) {
      n++;
      if (i + 1 >= at.length || at[i + 1] - at[i] > GAP_MS) {
        sizes.push(n);
        n = 0;
      }
    }
    const big = sizes.filter((x) => x > 1);
    return {
      bursts: big.length,
      maxBurst: sizes.length ? Math.max(...sizes) : 0,
      meanBurst: big.length ? big.reduce((a, x) => a + x, 0) / big.length : 0,
      frames: at.length,
    };
  };
}

export interface Run {
  stems: number;
  seconds: number;
  bytes: number;
  wallMs: number;
  maxFrameGapMs: number; // what the eye sees — a frozen picture is one long gap
  gapsOver50: number;
  gapsOver100: number;
  tbtMs: number; // total blocking time: the part of each frame gap over 50 ms, summed
  frames: number;
  decodedSeconds: number;
  delivery: Delivery;
  worstDropMB: number;
  drops: number;
  biggestDropMB: number;
  heapRead: boolean; // false → performance.memory is absent, so every drop above is a non-reading
}

/** A stem-shaped buffer: broadband, non-silent, non-periodic, so Opus cannot cheat the packet
 *  sizes. Silence would encode to almost nothing and measure almost nothing. */
function makeStem(ctx: BaseAudioContext, seconds: number, ch: number): AudioBuffer {
  const sr = 48000;
  const b = ctx.createBuffer(ch, Math.floor(seconds * sr), sr);
  for (let c = 0; c < ch; c++) {
    const d = b.getChannelData(c);
    let lp = 0;
    for (let i = 0; i < d.length; i++) {
      const noise = Math.random() * 2 - 1;
      lp = lp * 0.86 + noise * 0.14; // a bass-ish bed, so it is not white
      const tone = Math.sin((i / sr) * 2 * Math.PI * (110 + c * 3)) * 0.35;
      const beat = i % (sr / 2) < 2000 ? 0.5 : 0; // a transient twice a second
      d[i] = Math.max(-1, Math.min(1, lp * 2 + tone + beat * (Math.random() * 2 - 1)));
    }
  }
  return b;
}

/** Frame gaps across a window, sampled by rAF — the measure that survives when longtask does not
 *  fire, and the one that corresponds to what a person sees. */
const heapMB = (): number => {
  const m = (performance as unknown as { memory?: { usedJSHeapSize?: number } }).memory;
  return m?.usedJSHeapSize ? m.usedJSHeapSize / 1048576 : 0;
};

function watchFrames(): { stop: () => { max: number; over50: number; over100: number; tbt: number; n: number; worstDropMB: number; drops: number; biggestDropMB: number } } {
  // ★ THE CLOCK STARTS ON THE FIRST TICK, NOT ON THE CALL. The first version measured from
  // watchFrames() to the first rAF and then threw that sample away as "the time before the window
  // opened" — but the decode begins immediately, so that sample was mostly stem 1's block. It
  // showed up as every configuration reporting exactly THREE gaps over 50 ms for FOUR stems, which
  // is the tell: a count that never varies is a structure, not a measurement. Anchoring on the
  // first tick loses only the ~16 ms before it and keeps all four stems.
  // ★ AND THE HEAP AT EVERY TICK. The shape that survived — flat across a 16x budget range, a large
  // STEP the moment any sleep exists — is not an accumulation's signature; accumulations scale with
  // what accumulates. It is a ONE-OFF event whose size is indifferent to our budget, and the
  // obvious one-off is a major collection. Sampling used heap beside the gap costs one read per
  // frame and is decisive either way: if the worst gap sits in an interval where the heap DROPPED
  // by megabytes it is GC; if the heap did not move across it, GC is out. (Metron's call, after his
  // own backpressure reading lost its only distinguishing prediction.)
  const gaps: number[] = [];
  const heap: number[] = [];
  let last = -1;
  let live = true;
  const tick = () => {
    if (!live) return;
    const now = performance.now();
    if (last >= 0) {
      gaps.push(now - last);
      heap.push(heapMB());
    }
    last = now;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return {
    stop: () => {
      live = false;
      const g = gaps;
      // The heap DROP across each interval: sample before it minus sample after it.
      const drop = (i: number) => (i > 0 ? heap[i - 1] - heap[i] : 0);
      let wi = 0;
      for (let i = 1; i < g.length; i++) if (g[i] > g[wi]) wi = i;
      let biggest = 0;
      let drops = 0;
      for (let i = 1; i < g.length; i++) {
        const d = drop(i);
        if (d > biggest) biggest = d;
        if (d > 4) drops++; // a major collection moves megabytes; 4 MB is well clear of noise
      }
      return {
        max: g.length ? Math.max(...g) : 0,
        over50: g.filter((x) => x > 50).length,
        over100: g.filter((x) => x > 100).length,
        tbt: g.reduce((a, x) => a + Math.max(0, x - 50), 0),
        n: g.length,
        worstDropMB: g.length ? drop(wi) : 0, // the heap change across the WORST gap specifically
        drops,
        biggestDropMB: biggest,
      };
    },
  };
}

// ★ THE POSITIVE CONTROL, on tonight's rule: if the instrument cannot see a collection we CAUSED,
// its silence about one we did not cause says nothing. Allocates hard, forces a collection at a
// known moment, and reports whether the watcher registered a drop and a gap.
(globalThis as unknown as { stemlabGcControl: () => Promise<{ seenDropMB: number; gapMs: number; forced: boolean; heapRead: boolean }> }).stemlabGcControl =
  async () => {
    const g = globalThis as unknown as { gc?: () => void };
    const w = watchFrames();
    let junk: number[][] | null = [];
    for (let i = 0; i < 400; i++) junk.push(new Array(20_000).fill(i));
    await new Promise<void>((r) => setTimeout(r, 300));
    junk = null;
    g.gc?.();
    await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
    const f = w.stop();
    return { seenDropMB: f.biggestDropMB, gapMs: f.max, forced: typeof g.gc === "function", heapRead: heapMB() > 0 };
  };

(globalThis as unknown as { stemlabSupported: () => Promise<boolean> }).stemlabSupported = async () => {
  const g = globalThis as unknown as { AudioDecoder?: { isConfigSupported: (c: unknown) => Promise<{ supported: boolean }> } };
  if (!g.AudioDecoder) return false;
  const d = await g.AudioDecoder.isConfigSupported({ codec: "opus", sampleRate: 48000, numberOfChannels: 2 });
  return !!d.supported;
};

(globalThis as unknown as { stemlabRun: (o: { seconds: number; stems: number; sliceMs: number | null }) => Promise<Run> }).stemlabRun =
  async ({ seconds, stems, sliceMs }) => {
    const ctx = new OfflineAudioContext(2, 128, 48000);
    const blob = await encodeStemOpus(makeStem(ctx, seconds, 2));

    // Measure the DECODE only — the encode is a fixture, and in the app it happens once, offline.
    const readDeliveries = watchDeliveries();
    const w = watchFrames();
    const t0 = performance.now();
    let decodedSeconds = 0;
    for (let i = 0; i < stems; i++) {
      const out = await decodeStemOpus(ctx, blob.slice(0), sliceMs == null ? Infinity : sliceMs);
      decodedSeconds += out.duration;
    }
    const wallMs = performance.now() - t0;
    // ★ AND THE TRAILING EDGE, WHICH IS THE SAME BUG AS THE LEADING ONE. Stopping the instant the
    // loop returns discards the LAST stem's block, because the rAF tick that would record it has
    // not fired yet. That is why every configuration reported exactly THREE gaps over 50 ms for
    // FOUR stems — I fixed the head of the window and left the tail, and the invariant count was
    // still telling me so. Two frames of idle before stopping lets the final gap land.
    await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
    const f = w.stop();
    const delivery = readDeliveries();
    return {
      stems,
      seconds,
      bytes: blob.byteLength,
      wallMs,
      maxFrameGapMs: f.max,
      gapsOver50: f.over50,
      gapsOver100: f.over100,
      tbtMs: f.tbt,
      frames: f.n,
      decodedSeconds,
      delivery,
      worstDropMB: f.worstDropMB,
      drops: f.drops,
      biggestDropMB: f.biggestDropMB,
      heapRead: heapMB() > 0,
    };
  };
