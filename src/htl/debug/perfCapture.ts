// PERFORMANCE CAPTURE: the "it feels laggy" counterpart of the MIDI capture.
//
// Operator, 2026-11-02: "im also noticing lag and performance issues around audio, responsiveness,
// and fps." None of it reproduced off their machine. A headless Chromium on the same box, on the
// real GPU, with four neural stems on a 2x display, held 60 fps and spent ~0.5 ms a frame on the
// waveform; an earlier "13-17 ms per draw" reading came from a Chrome window the compositor was
// starving of frames, where every draw was a jump and so a full rebuild. The only place the lag
// exists is the operator's own tab, with their library, heap and controller. So this records it
// THERE, the same way the jog was fixed: capture, hand over a file, replay the numbers.
//
// What it records while armed (module-level, so it keeps running with Settings closed):
//   • every rAF frame gap (what the eye sees),
//   • Long Animation Frames, with the scripts the browser blames for each (who held the thread),
//   • Event Timing for interactions slower than one frame (click/key/pointer → next paint),
//   • once a second: JS heap (Chromium), and the audio probe (worklet underruns = audible dropouts,
//     output/base latency, context state),
//   • every MIDI message's arrival-to-handler delay is NOT here: Web MIDI timestamps are already in
//     the MIDI capture.
// Cost while armed: one rAF push and a 1 Hz sample; observers are browser-side. Off by default.

export interface AudioProbe {
  underruns: number;
  outputLatencyMs: number;
  baseLatencyMs?: number;
  state: string;
  playing: boolean;
  [k: string]: unknown; // engine-shaping context (stems loaded, stretch preset…)
}

export interface PerfCapture {
  kind: "htl-perf";
  version: 1;
  capturedAt: number;
  durationMs: number;
  env: Record<string, unknown>;
  frames: number[]; // rAF gaps, ms, in order (rounded to 0.1)
  loafs: Array<{ t: number; d: number; block: number; render: number; scripts: Array<{ inv: string; fn: string; src: string; d: number; layout: number }> }>;
  events: Array<{ t: number; name: string; d: number; wait: number; proc: number; target: string }>;
  samples: Array<{ t: number; heapMb?: number; audio?: AudioProbe }>;
  marks: Array<{ t: number; label: string }>;
  /** Timed app work (e.g. waveform rebuilds): kind → [t, ms] pairs. Filled via perfWork(). */
  work?: Record<string, Array<[number, number]>>;
}

let audioProbe: (() => AudioProbe) | null = null;
/** The app registers how to read audio-thread health (the engine lives there, not here). */
export function setPerfAudioProbe(fn: (() => AudioProbe) | null): void {
  audioProbe = fn;
}

let cur: PerfCapture | null = null;
let t0 = 0;
let raf = 0;
let timer: ReturnType<typeof setInterval> | null = null;
let observers: PerformanceObserver[] = [];
const MAX_FRAMES = 60 * 60 * 10; // ten minutes at 60 Hz; a forgotten recording stays bounded

const r1 = (n: number) => Math.round(n * 10) / 10;

export function perfCapturing(): boolean {
  return cur != null;
}

export function perfCaptureSeconds(): number {
  return cur ? (performance.now() - t0) / 1000 : 0;
}

/** Drop a labelled moment into the recording (e.g. "scratching now"). */
/** Record one timed piece of app work while a capture runs (a no-op otherwise, so callers can
 *  time unconditionally). Bounded per kind. */
export function perfWork(kind: string, ms: number): void {
  if (!cur) return;
  const w = (cur.work ??= {});
  const xs = (w[kind] ??= []);
  if (xs.length < 20000) xs.push([r1(performance.now() - t0), Math.round(ms * 100) / 100]);
}

export function perfMark(label: string): void {
  if (cur) cur.marks.push({ t: r1(performance.now() - t0), label });
}

function describeTarget(el: unknown): string {
  const e = el as { tagName?: string; className?: unknown; id?: string } | null;
  if (!e || !e.tagName) return "";
  const cls = typeof e.className === "string" ? e.className.split(/\s+/).filter(Boolean).slice(0, 2).join(".") : "";
  return `${e.tagName.toLowerCase()}${e.id ? "#" + e.id : ""}${cls ? "." + cls : ""}`;
}

export function startPerfCapture(env: Record<string, unknown> = {}): void {
  if (cur) return;
  t0 = performance.now();
  const nav = navigator as unknown as { deviceMemory?: number; hardwareConcurrency?: number; userAgent: string };
  cur = {
    kind: "htl-perf",
    version: 1,
    capturedAt: Date.now(),
    durationMs: 0,
    env: {
      ua: nav.userAgent,
      dpr: window.devicePixelRatio,
      viewport: [window.innerWidth, window.innerHeight],
      cores: nav.hardwareConcurrency,
      deviceMemoryGb: nav.deviceMemory,
      crossOriginIsolated: (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated,
      ...env,
    },
    frames: [],
    loafs: [],
    events: [],
    samples: [],
    marks: [],
  };
  const c = cur;
  let last = performance.now();
  const tick = (now: number) => {
    if (cur !== c) return;
    if (c.frames.length < MAX_FRAMES) c.frames.push(r1(now - last));
    last = now;
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);

  const sample = () => {
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    let audio: AudioProbe | undefined;
    try {
      audio = audioProbe?.();
    } catch {
      audio = undefined;
    }
    c.samples.push({ t: r1(performance.now() - t0), heapMb: mem ? Math.round(mem.usedJSHeapSize / 1048576) : undefined, audio });
  };
  sample();
  timer = setInterval(sample, 1000);

  const observe = (type: string, opts: Record<string, unknown>, fn: (e: PerformanceEntry) => void) => {
    try {
      const o = new PerformanceObserver((l) => {
        if (cur !== c) return;
        for (const e of l.getEntries()) fn(e);
      });
      o.observe({ type, ...opts } as PerformanceObserverInit);
      observers.push(o);
    } catch {
      c.env[`no_${type}`] = true; // this browser lacks it; the file says so instead of looking clean
    }
  };
  observe("long-animation-frame", {}, (e) => {
    const l = e as PerformanceEntry & {
      blockingDuration?: number;
      renderStart?: number;
      scripts?: Array<{ invoker?: string; sourceFunctionName?: string; sourceURL?: string; sourceCharPosition?: number; duration: number; forcedStyleAndLayoutDuration?: number }>;
    };
    if (c.loafs.length >= 5000) return;
    c.loafs.push({
      t: r1(l.startTime - t0),
      d: r1(l.duration),
      block: r1(l.blockingDuration ?? 0),
      render: r1(l.renderStart ? l.startTime + l.duration - l.renderStart : 0),
      scripts: (l.scripts ?? []).map((s) => ({
        inv: s.invoker ?? "",
        fn: s.sourceFunctionName ?? "",
        src: `${(s.sourceURL ?? "").split("/").pop()}:${s.sourceCharPosition ?? -1}`,
        d: r1(s.duration),
        layout: r1(s.forcedStyleAndLayoutDuration ?? 0),
      })),
    });
  });
  observe("event", { durationThreshold: 16 }, (e) => {
    const ev = e as PerformanceEntry & { processingStart: number; processingEnd: number; target?: unknown };
    if (c.events.length >= 5000) return;
    c.events.push({
      t: r1(ev.startTime - t0),
      name: ev.name,
      d: r1(ev.duration),
      wait: r1(ev.processingStart - ev.startTime),
      proc: r1(ev.processingEnd - ev.processingStart),
      target: describeTarget(ev.target),
    });
  });
}

/** Stop and hand back the recording (null if none was running). */
export function stopPerfCapture(): PerfCapture | null {
  const c = cur;
  if (!c) return null;
  cur = null;
  cancelAnimationFrame(raf);
  if (timer) clearInterval(timer);
  timer = null;
  for (const o of observers) o.disconnect();
  observers = [];
  c.durationMs = Math.round(performance.now() - t0);
  return c;
}

/** One-line verdict for the UI, so the operator sees something before sending the file. */
export function summarizePerf(c: PerfCapture): string {
  const f = [...c.frames].sort((a, b) => a - b);
  const q = (p: number) => (f.length ? f[Math.min(f.length - 1, Math.floor(p * f.length))] : 0);
  const janky = c.frames.filter((d) => d > 25).length;
  const slowEv = c.events.filter((e) => e.d > 100).length;
  const und = c.samples.map((s) => s.audio?.underruns ?? 0);
  const dropouts = und.length ? Math.max(0, und[und.length - 1] - und[0]) : 0;
  return `${(c.durationMs / 1000).toFixed(0)} s · ${c.frames.length} frames, p95 ${q(0.95).toFixed(1)} ms, ${janky} slow (>25 ms) · ${c.loafs.length} long frames · ${slowEv} slow inputs (>100 ms) · ${dropouts} audio dropouts`;
}

export function downloadPerfCapture(c: PerfCapture): void {
  const stamp = new Date(c.capturedAt).toISOString().slice(0, 19).replace(/[:T]/g, "");
  const blob = new Blob([JSON.stringify(c)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `perf-capture-${stamp}.json`;
  a.click();
  URL.revokeObjectURL(url);
}
