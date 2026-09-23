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
  // ★ WHERE THE BIGGEST BURST SITS INSIDE ITS STEM, 0..1. I called maxBurst ~3000-4000 "the flush()
  // drain, structural" — interpreted, not measured, and I said so. Metron pointed out it is one
  // field away from being measured: if it IS the flush it must land at the END of a stem in every
  // condition. If it floats, it is not the flush and it is a difference I have been discounting.
  maxBurstPos: number;
}

/** Wrap globalThis.AudioDecoder so every delivered frame is timestamped. Returns the reader. */
function watchDeliveries(): (bounds: { start: number; end: number }[]) => Delivery {
  const g = globalThis as unknown as { AudioDecoder: new (i: { output: (d: unknown) => void; error: (e: Error) => void }) => unknown };
  const Real = g.AudioDecoder;
  const at: number[] = [];
  g.AudioDecoder = class {
    constructor(init: { output: (d: unknown) => void; error: (e: Error) => void }) {
      const wrapped = { ...init, output: (d: unknown) => { at.push(performance.now()); init.output(d); } };
      return new Real(wrapped) as object;
    }
  } as unknown as typeof Real;
  return (bounds: { start: number; end: number }[]) => {
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
    // Re-walk to find WHERE the largest burst began, then locate that instant inside its own stem.
    let bi = 0;
    let best = -1;
    let cur = 0;
    let curStart = 0;
    for (let i = 0; i < at.length; i++) {
      if (cur === 0) curStart = at[i];
      cur++;
      if (i + 1 >= at.length || at[i + 1] - at[i] > GAP_MS) {
        if (cur > best) {
          best = cur;
          bi = curStart;
        }
        cur = 0;
      }
    }
    const owner = bounds.find((b) => bi >= b.start && bi <= b.end);
    return {
      bursts: big.length,
      maxBurst: sizes.length ? Math.max(...sizes) : 0,
      meanBurst: big.length ? big.reduce((a, x) => a + x, 0) / big.length : 0,
      frames: at.length,
      maxBurstPos: owner && owner.end > owner.start ? (bi - owner.start) / (owner.end - owner.start) : -1,
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

// The encoded fixture is deterministic per length and costs seconds to build. Cache it so a grid of
// sixteen runs pays for it once — and so the thing being compared is the decode, not the encode.
const fixtures = new Map<number, ArrayBuffer>();
async function fixture(ctx: BaseAudioContext, seconds: number): Promise<ArrayBuffer> {
  const hit = fixtures.get(seconds);
  if (hit) return hit;
  const blob = await encodeStemOpus(makeStem(ctx, seconds, 2));
  fixtures.set(seconds, blob);
  return blob;
}

// ★ THE YIELD PRIMITIVES. setTimeout(0) is the shipped one and the suspect: a timer task is DUE, so
// the browser runs it before it paints. rAF ranks BELOW rendering by construction — it IS the
// rendering step — so a rAF-shaped yield cannot starve a frame the way a timer can. scheduler.yield
// is the purpose-built one where it exists.
//
// ★ AN ABSENT PRIMITIVE MUST READ AS ABSENT, NOT AS A FALLBACK. If scheduler.yield is missing and we
// quietly substituted setTimeout, the grid would report a tie between two names for one thing — the
// unreadable-absence error this session has now made three times. So it returns null and the runner
// says so.
// ★ THE 2-1 SPLIT IS THE AXIS. setTimeout(0) and requestAnimationFrame have almost nothing in
// common as schedulers — different queues, different priorities, different relationship to the
// paint — and they landed within 1 ms of each other (482 vs 483). When two primitives that differ
// in every way you were reasoning about give the SAME answer, the variable is what they SHARE.
// What they share is that both put the continuation at the BACK of something, behind whatever
// arrived while we slept. scheduler.yield does not: it resumes AHEAD of newly-queued work.
//
// Metron's prediction, added here to be falsified rather than believed: postTask at
// user-blocking should behave like yield (fast), postTask at background like setTimeout (slow).
// Same API, same feature detection, ONE axis moved. Both fast → position is not the variable and
// something specific to yield() is. Both slow → likewise. A split → the first mechanism all night
// that explains the whole grid rather than one column.
export type YieldName = "timeout" | "raf" | "scheduler" | "postTask-ub" | "postTask-bg" | "none";
function yieldFor(name: YieldName): (() => Promise<void>) | null {
  const g = globalThis as unknown as { scheduler?: { yield?: () => Promise<void>; postTask?: (f: () => void, o: unknown) => Promise<void> } };
  switch (name) {
    case "timeout":
      return () => new Promise<void>((r) => setTimeout(r, 0));
    case "raf":
      return () => new Promise<void>((r) => requestAnimationFrame(() => r()));
    case "scheduler":
      // yield() ONLY — no postTask fallback here, or this cell would silently become one of the
      // two below and the grid would report a tie between two names for one thing.
      return g.scheduler?.yield ? () => g.scheduler!.yield!() : null;
    case "postTask-ub":
      return g.scheduler?.postTask ? () => g.scheduler!.postTask!(() => {}, { priority: "user-blocking" }) : null;
    case "postTask-bg":
      return g.scheduler?.postTask ? () => g.scheduler!.postTask!(() => {}, { priority: "background" }) : null;
    case "none":
      return null;
  }
}

/** A competing rAF animation doing real per-frame work — the thing the slicing exists to protect.
 *  Without one, "does the yield starve rendering" cannot be asked at all. */
function competingAnimation(): () => number {
  let live = true;
  let painted = 0;
  const cv = document.createElement("canvas");
  cv.width = 320;
  cv.height = 120;
  const g2 = cv.getContext("2d");
  const tick = () => {
    if (!live) return;
    painted++;
    if (g2) {
      g2.clearRect(0, 0, 320, 120);
      for (let i = 0; i < 120; i++) {
        g2.fillStyle = `hsl(${(painted + i) % 360} 70% 50%)`;
        g2.fillRect(i * 2.5, (i * 7 + painted) % 120, 2, 8);
      }
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return () => {
    live = false;
    return painted;
  };
}

export interface Cell {
  yieldName: YieldName;
  competing: boolean;
  available: boolean; // false → the primitive does not exist here; every number below is a non-reading
  wallMs: number;
  tbtMs: number;
  maxFrameGapMs: number;
  paintedFps: number; // the competing animation's achieved frame rate — 0 when not running
}

(globalThis as unknown as { stemlabGrid: (o: { seconds: number; stems: number; sliceMs: number; yieldName: YieldName; competing: boolean }) => Promise<Cell> }).stemlabGrid =
  async ({ seconds, stems, sliceMs, yieldName, competing }) => {
    const ctx = new OfflineAudioContext(2, 128, 48000);
    const blob = await fixture(ctx, seconds);
    const yieldTo = yieldFor(yieldName);
    if (yieldName !== "none" && !yieldTo) {
      return { yieldName, competing, available: false, wallMs: 0, tbtMs: 0, maxFrameGapMs: 0, paintedFps: 0 };
    }
    const stopAnim = competing ? competingAnimation() : null;
    const w = watchFrames();
    const t0 = performance.now();
    for (let i = 0; i < stems; i++) {
      await decodeStemOpus(ctx, blob.slice(0), yieldName === "none" ? { sliceMs: Infinity } : { sliceMs, yieldTo: yieldTo! });
    }
    const wallMs = performance.now() - t0;
    await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
    const f = w.stop();
    const painted = stopAnim ? stopAnim() : 0;
    return {
      yieldName,
      competing,
      available: true,
      wallMs,
      tbtMs: f.tbt,
      maxFrameGapMs: f.max,
      paintedFps: painted ? (painted / wallMs) * 1000 : 0,
    };
  };

(globalThis as unknown as { stemlabRun: (o: { seconds: number; stems: number; sliceMs: number | null }) => Promise<Run> }).stemlabRun =
  async ({ seconds, stems, sliceMs }) => {
    const ctx = new OfflineAudioContext(2, 128, 48000);
    const blob = await fixture(ctx, seconds);

    // Measure the DECODE only — the encode is a fixture, and in the app it happens once, offline.
    const readDeliveries = watchDeliveries();
    const w = watchFrames();
    const t0 = performance.now();
    let decodedSeconds = 0;
    const bounds: { start: number; end: number }[] = [];
    for (let i = 0; i < stems; i++) {
      const s0 = performance.now();
      const out = await decodeStemOpus(ctx, blob.slice(0), { sliceMs: sliceMs == null ? Infinity : sliceMs });
      bounds.push({ start: s0, end: performance.now() });
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
    const delivery = readDeliveries(bounds);
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
