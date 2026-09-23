// STEMLAB harness — runs the REAL encodeStemOpus/decodeStemOpus in a page, and measures what the
// main thread was doing while they ran. Not a reimplementation: the only knob moved between the
// two runs is decodeStemOpus's own slice budget.
import { encodeStemOpus, decodeStemOpus } from "../../src/htl/stems/opus";

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
function watchFrames(): { stop: () => { max: number; over50: number; over100: number; tbt: number; n: number } } {
  // ★ THE CLOCK STARTS ON THE FIRST TICK, NOT ON THE CALL. The first version measured from
  // watchFrames() to the first rAF and then threw that sample away as "the time before the window
  // opened" — but the decode begins immediately, so that sample was mostly stem 1's block. It
  // showed up as every configuration reporting exactly THREE gaps over 50 ms for FOUR stems, which
  // is the tell: a count that never varies is a structure, not a measurement. Anchoring on the
  // first tick loses only the ~16 ms before it and keeps all four stems.
  const gaps: number[] = [];
  let last = -1;
  let live = true;
  const tick = () => {
    if (!live) return;
    const now = performance.now();
    if (last >= 0) gaps.push(now - last);
    last = now;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return {
    stop: () => {
      live = false;
      const g = gaps;
      return {
        max: g.length ? Math.max(...g) : 0,
        over50: g.filter((x) => x > 50).length,
        over100: g.filter((x) => x > 100).length,
        tbt: g.reduce((a, x) => a + Math.max(0, x - 50), 0),
        n: g.length,
      };
    },
  };
}

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
    const w = watchFrames();
    const t0 = performance.now();
    let decodedSeconds = 0;
    for (let i = 0; i < stems; i++) {
      const out = await decodeStemOpus(ctx, blob.slice(0), sliceMs == null ? Infinity : sliceMs);
      decodedSeconds += out.duration;
    }
    const wallMs = performance.now() - t0;
    const f = w.stop();
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
    };
  };
