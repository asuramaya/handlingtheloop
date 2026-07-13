/// <reference lib="webworker" />
// Whisper-on-vocal-stem lyric transcription, OFF the main + audio threads. The main
// thread hands us a COPY of the isolated vocals PCM (so playback keeps its own buffer);
// we resample it to 16 kHz mono and decode with transformers.js. WebGPU on Chromium,
// wasm elsewhere — mirrors the stems separator's bundle/UA split (and dodges the same
// Safari JSEP leak). Output lines feed the very same caption ribbon YouTube captions do.
//
// transformers.js is pulled from a CDN at runtime (like the separator's onnxruntime-web),
// so it adds nothing to the app bundle and only downloads when lyrics are first used.
// CDN + version are the one thing to verify on a live run; any failure here is caught and
// reported so the caller falls back to YouTube captions — the feature never hard-crashes.
const TJS = "https://esm.sh/@huggingface/transformers@3";

import { FFT, hannPeriodic } from "../stems/fft";

/* eslint-disable @typescript-eslint/no-explicit-any */
interface AsrChunk {
  text: string;
  timestamp: [number, number | null];
}
type AsrPipe = (audio: Float32Array, opts: Record<string, unknown>) => Promise<{ text: string; chunks?: AsrChunk[] }>;

let tjs: any = null;
const pipes = new Map<string, Promise<AsrPipe>>();
// What the GPU ACTUALLY ran, per repo — the q4 path or the fp32 fallback — plus the library
// version. Both are reported in the alignment diagnostic: transformers.js has shipped genuinely
// broken word timestamps more than once, so "which version produced these times" is evidence.
const pipeMeta = new Map<string, { dtype: string; tjs: string }>();

const UA = (typeof navigator !== "undefined" && navigator.userAgent) || "";
const WEBGPU = typeof navigator !== "undefined" && !!(navigator as any).gpu && /Chrome\/|Chromium\//.test(UA);

async function loadTjs(): Promise<any> {
  if (!tjs) {
    tjs = await import(/* @vite-ignore */ TJS);
    tjs.env.allowLocalModels = false; // models come from the HF hub, not a local /models dir
  }
  return tjs;
}

// Build (and cache) the ASR pipeline for a model repo. Model download progress → caller.
//
// WHY THE DECODER IS 4-BIT ON WebGPU: Whisper decodes AUTOREGRESSIVELY — one token at a time,
// each a separate GPU dispatch — so the decoder's weight precision dominates wall-clock (this
// is why transcription feels slower than the single-pass demucs forward). Running it at fp32
// was the bottleneck. q4 (4-bit, the transformers.js whisper-webgpu reference config) roughly
// halves decode time. The encoder is a SINGLE pass over the whole clip → keep it fp32 for
// transcription accuracy. q4 uses INTEGER MatMulNBits kernels, NOT the fp16 shader path that
// ORT-web's WebGPU EP miscomputes / can't compile on Linux+NVIDIA (see the demucs fp16 saga),
// so it's both faster AND safe here. If a repo lacks q4 files, fall back to fp32 (no hard fail).
function getPipe(repo: string): Promise<AsrPipe> {
  let p = pipes.get(repo);
  if (!p) {
    p = (async () => {
      const t = await loadTjs();
      const onProg = (e: any) => {
        if (e?.status === "progress" && typeof e.progress === "number") {
          (self as any).postMessage({ type: "progress", phase: "model", pct: Math.round(e.progress) });
        }
      };
      const ver = String(t.env?.version ?? "?");
      const build = async (device: string, dtype: any, label: string) => {
        const p = (await t.pipeline("automatic-speech-recognition", repo, {
          device,
          dtype,
          progress_callback: onProg,
        })) as AsrPipe;
        pipeMeta.set(repo, { dtype: `${device}/${label}`, tjs: ver });
        return p;
      };
      if (WEBGPU) {
        try {
          return await build("webgpu", { encoder_model: "fp32", decoder_model_merged: "q4" }, "enc:fp32+dec:q4");
        } catch {
          (self as any).postMessage({ type: "progress", phase: "model", pct: 100 });
          return await build("webgpu", "fp32", "fp32"); // repo has no q4 export → full-precision
        }
      }
      return await build("wasm", "q8", "q8"); // non-Chromium: stable CPU bundle
    })();
    // ★ EVICT A FAILED BUILD. The memo used to keep the REJECTED promise, so a single transient
    // failure — a CDN blip, an interrupted model download — was cached and every later transcribe
    // for this repo failed instantly with that same stale error, for the whole life of the page.
    // Lyrics were dead until a reload. Dropping the entry lets the next attempt genuinely retry.
    p.catch(() => {
      if (pipes.get(repo) === p) pipes.delete(repo);
    });
    pipes.set(repo, p);
  }
  return p;
}

// Linear-resample mono PCM to Whisper's required 16 kHz.
function to16k(pcm: Float32Array, sr: number): Float32Array {
  if (sr === 16000) return pcm;
  const ratio = 16000 / sr;
  const n = Math.max(1, Math.floor(pcm.length * ratio));
  const out = new Float32Array(n);
  const step = sr / 16000;
  for (let i = 0; i < n; i++) {
    const x = i * step;
    const i0 = x | 0;
    const f = x - i0;
    const a = pcm[i0] || 0;
    const b = i0 + 1 < pcm.length ? pcm[i0 + 1] : a;
    out[i] = a + (b - a) * f;
  }
  return out;
}

interface OutLine {
  start: number;
  end: number;
  text: string;
  words?: { t: number; w: string }[];
}

// Strip Whisper's NON-SPEECH annotations — the tags it emits over silence / instrumentals:
// [MUSIC], [BLANK_AUDIO], (music), [Applause], ♪…♪ etc. Removing them (and dropping anything
// that's nothing but a tag) is the graceful-silence handling on the text side.
function stripNonSpeech(s: string): string {
  return s
    .replace(/[[(][^\])]*[\])]/g, " ") // [..] or (..) tags anywhere
    .replace(/[♪♫]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ---- vocal-onset alignment ------------------------------------------------------------
// Whisper word starts are only ROUGHLY right (DTW over cross-attention; ~±100 ms, biased
// early, fuzziest on sung/held vowels). We have the clean vocal stem, so we detect the REAL
// vocal onsets via spectral flux (catches legato note changes, not just energy rises) and
// snap each word to the nearest onset within a small window — pulling words onto the actual
// transients. Where there's no clear onset (true legato) the word keeps Whisper's time.
const ON_N = 1024;
const ON_HOP = 160; // 10 ms @ 16 kHz
const ON_BINS = ON_N / 2;
const onFft = new FFT(ON_N);
const onWin = hannPeriodic(ON_N);

function detectOnsets(audio: Float32Array): number[] {
  const frames = Math.floor((audio.length - ON_N) / ON_HOP) + 1;
  if (frames < 4) return [];
  const re = new Float32Array(ON_N);
  const im = new Float32Array(ON_N);
  let prevMag = new Float32Array(ON_BINS);
  let curMag = new Float32Array(ON_BINS);
  const flux = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    const off = f * ON_HOP;
    for (let i = 0; i < ON_N; i++) {
      re[i] = (audio[off + i] || 0) * onWin[i];
      im[i] = 0;
    }
    onFft.transform(re, im, false);
    let fl = 0;
    for (let k = 0; k < ON_BINS; k++) {
      const m = Math.hypot(re[k], im[k]);
      curMag[k] = m;
      const d = m - prevMag[k];
      if (d > 0) fl += d; // half-wave-rectified spectral flux
    }
    flux[f] = fl;
    const t = prevMag;
    prevMag = curMag;
    curMag = t;
  }
  // Adaptive peak-pick: a local max comfortably above its local mean, ≥50 ms apart.
  const onsets: number[] = [];
  const W = 8; // ±80 ms local window
  let lastF = -100;
  for (let f = 1; f < frames - 1; f++) {
    if (flux[f] < flux[f - 1] || flux[f] < flux[f + 1]) continue;
    let s = 0;
    let c = 0;
    for (let j = Math.max(0, f - W); j <= Math.min(frames - 1, f + W); j++) {
      s += flux[j];
      c++;
    }
    if (flux[f] > (s / c) * 1.6 + 1e-6 && f - lastF >= 5) {
      onsets.push((f * ON_HOP) / 16000);
      lastF = f;
    }
  }
  return onsets;
}

// ---- alignment MEASUREMENT (see LyricsDiag in types.ts) ---------------------------------
// Run BEFORE snapping, over a WIDE window, so we see the true error instead of the error the
// snap is able to reach. This is what turns "the lyrics don't line up" from a complaint into a
// number that names its own fix.
const DIAG_SEARCH_S = 2.0;

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function measureAlignment(lines: OutLine[], onsets: number[]): {
  words: number;
  matched: number;
  medianLag: number;
  madLag: number;
  driftMsPerMin: number;
  within160: number;
} {
  const ts: number[] = [];
  const lags: number[] = [];
  let words = 0;
  for (const ln of lines) {
    for (const wd of ln.words ?? []) {
      words++;
      if (!onsets.length) continue;
      const near = nearestOnset(onsets, wd.t);
      const lag = near - wd.t; // + = the real vocal starts AFTER Whisper said it did
      if (Math.abs(lag) <= DIAG_SEARCH_S) {
        ts.push(wd.t);
        lags.push(lag);
      }
    }
  }
  if (!lags.length) {
    return { words, matched: 0, medianLag: 0, madLag: 0, driftMsPerMin: 0, within160: 0 };
  }
  const med = median(lags);
  const mad = median(lags.map((l) => Math.abs(l - med)));
  // Least-squares slope of lag vs track time → a chunk/rate bug drifts, a pipeline offset doesn't.
  const n = lags.length;
  const mt = ts.reduce((a, b) => a + b, 0) / n;
  const ml = lags.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (ts[i] - mt) * (lags[i] - ml);
    den += (ts[i] - mt) ** 2;
  }
  const slope = den > 1e-9 ? num / den : 0; // seconds of lag per second of track
  return {
    words,
    matched: n,
    medianLag: med,
    madLag: mad,
    driftMsPerMin: slope * 60 * 1000,
    within160: lags.filter((l) => Math.abs(l) <= 0.16).length / n,
  };
}

function nearestOnset(onsets: number[], t: number): number {
  let lo = 0;
  let hi = onsets.length - 1;
  if (t <= onsets[0]) return onsets[0];
  if (t >= onsets[hi]) return onsets[hi];
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (onsets[m] < t) lo = m + 1;
    else hi = m;
  }
  const a = onsets[lo - 1];
  const b = onsets[lo];
  return t - a <= b - t ? a : b;
}

// Snap each word's onset to the nearest vocal onset within ±WIN; keep its held duration and
// stay strictly increasing (don't reorder words onto the same/earlier onset).
function snapToOnsets(lines: OutLine[], onsets: number[]): OutLine[] {
  if (onsets.length < 2) return lines;
  const WIN = 0.16;
  for (const ln of lines) {
    if (!ln.words?.length) continue;
    let prevT = -Infinity;
    for (const wd of ln.words) {
      const near = nearestOnset(onsets, wd.t);
      if (Math.abs(near - wd.t) <= WIN && near > prevT) wd.t = near;
      prevT = wd.t;
    }
    ln.start = ln.words[0].t;
    ln.end = Math.max(ln.end, ln.words[ln.words.length - 1].t);
  }
  return lines;
}

// Group Whisper WORD chunks into lines. SILENCE is handled here: a gap between words longer
// than GAP_S starts a new line, so an instrumental break leaves a clean break (no line
// stretched across it), and a sentence-ending word closes a line. Consecutive duplicate
// lines (the classic silence hallucination) are dropped. Each line keeps per-word start
// times so the ribbon can light the exact word being sung.
function groupWords(chunks: AsrChunk[]): OutLine[] {
  const GAP_S = 1.4;
  const MAX_WORDS = 9;
  const lines: OutLine[] = [];
  let cur: { start: number; end: number; words: { t: number; w: string; d?: number }[] } | null = null;
  const flush = () => {
    if (cur && cur.words.length) {
      lines.push({ start: cur.words[0].t, end: Math.max(cur.end, cur.words[cur.words.length - 1].t + 0.2), text: cur.words.map((x) => x.w).join(" "), words: cur.words });
    }
    cur = null;
  };
  for (const c of chunks) {
    const w = stripNonSpeech(c.text || "");
    const s = c.timestamp?.[0];
    if (!w || s == null) continue; // empty after stripping a [MUSIC]/♪ tag → skip (silence)
    if (cur && (s - cur.end > GAP_S || cur.words.length >= MAX_WORDS)) flush();
    if (!cur) cur = { start: s, end: s, words: [] };
    const e = c.timestamp?.[1] ?? s;
    cur.words.push({ t: s, w, d: Math.max(0, Math.round((e - s) * 100) / 100) }); // held-word duration
    cur.end = e;
    if (/[.?!]["')\]]?$/.test(w) && cur.words.length >= 3) flush(); // sentence end → break
  }
  flush();
  const out: OutLine[] = [];
  for (const l of lines) if (!out.length || out[out.length - 1].text.toLowerCase() !== l.text.toLowerCase()) out.push(l);
  return out;
}

// Segment-level fallback (model has no word alignment): drop empties + verbatim repeats.
function cleanSegments(chunks: AsrChunk[] | undefined): OutLine[] {
  if (!chunks?.length) return [];
  const lines: OutLine[] = [];
  let prev = "";
  for (const c of chunks) {
    const text = stripNonSpeech(c.text || "");
    if (!text) continue; // [MUSIC] / [BLANK_AUDIO] / ♪ → dropped
    const key = text.toLowerCase();
    if (key === prev) continue;
    prev = key;
    const start = c.timestamp?.[0] ?? (lines.length ? lines[lines.length - 1].end : 0);
    const end = c.timestamp?.[1] ?? start + 2;
    lines.push({ start, end, text });
  }
  return lines;
}

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data;
  if (msg?.type !== "transcribe") return;
  const { id, pcm, sampleRate, repo, language } = msg as {
    id: number;
    pcm: Float32Array;
    sampleRate: number;
    repo: string;
    language?: string;
  };
  try {
    const pipe = await getPipe(repo);
    const audio = to16k(pcm, sampleRate);
    const SR = 16000;
    const total = audio.length;
    (self as any).postMessage({ type: "progress", phase: "decode", pct: 0, id });

    // MANUAL 30 s / 5 s-overlap chunking (instead of one pipe() call over the whole track). Three
    // wins over letting transformers.js chunk internally: (1) a real per-chunk decode % to show in
    // the UI; (2) EXPLICIT per-chunk time offsets — the library doesn't reliably accumulate them on
    // long word-timestamp runs, so words drifted progressively EARLY; adding `offset` ourselves
    // makes word times correct by construction (this supersedes the old drift diagnostic); (3) it
    // sets up streaming partial lines later. Each chunk OWNS half of each overlap so a word near a
    // seam is emitted by exactly one chunk (no dupes / no gaps).
    const CHUNK = 30 * SR;
    const OVERLAP = 5 * SR;
    const step = CHUNK - OVERLAP; // 25 s hop
    const nChunks = total <= CHUNK ? 1 : Math.ceil((total - OVERLAP) / step);
    const langOpt = language ? { language } : {};

    let wordMode = true;
    let wordError: string | undefined; // set if word timestamps were abandoned — see the catch below
    const t0 = Date.now();
    const wChunks: AsrChunk[] = []; // accumulated WORD chunks at ABSOLUTE time (word mode)
    const sChunks: AsrChunk[] = []; // accumulated SEGMENT chunks at absolute time (fallback)

    for (let ci = 0; ci < nChunks; ci++) {
      // Advance the bar as each chunk STARTS (not only when it finishes) — a single chunk can
      // take seconds, so end-only updates make the slow first chunk look hung. Reserve the last
      // 5% for the onset-align pass after the loop.
      (self as any).postMessage({ type: "progress", phase: "decode", pct: Math.round((ci / nChunks) * 95), id });
      const start = ci * step;
      const end = Math.min(total, start + CHUNK);
      const seg = audio.slice(start, end); // copy — the pipe may detach/transfer its input
      const offset = start / SR;
      // This chunk's authoritative span (absolute seconds): cede half of each overlap to the
      // neighbour so a seam word lands in exactly one chunk.
      const vStart = ci > 0 ? offset + OVERLAP / SR / 2 : 0;
      const vEnd = end >= total ? Infinity : end / SR - OVERLAP / SR / 2;
      const push = (dst: AsrChunk[], out: { chunks?: AsrChunk[] }) => {
        for (const c of out.chunks ?? []) {
          const t = (c.timestamp?.[0] ?? 0) + offset;
          const e = (c.timestamp?.[1] ?? t) + offset;
          if (t >= vStart && t < vEnd) dst.push({ text: c.text, timestamp: [t, e] });
        }
      };

      if (wordMode) {
        try {
          push(wChunks, await pipe(seg, { return_timestamps: "word", ...langOpt }));
        } catch (err: any) {
          // The model lacks word-alignment heads → drop to segment mode for the WHOLE track and
          // restart from chunk 0 so the result is never half word / half segment.
          // ★ RECORD WHY. This fallback used to be silent, and a silent drop to segment timestamps
          // looks EXACTLY like "the lyrics don't line up" — coarse whole-line cues instead of the
          // word comb. If it fires, the diagnostic now names it instead of leaving us guessing.
          wordError = String(err?.message || err);
          wordMode = false;
          wChunks.length = 0;
          ci = -1;
          continue;
        }
      } else {
        push(sChunks, await pipe(seg, { return_timestamps: true, ...langOpt }));
      }
      (self as any).postMessage({ type: "progress", phase: "decode", pct: Math.round(((ci + 1) / nChunks) * 95), id });
    }

    // ★ THE GPU IS FREE FROM HERE ON. Everything below is CPU: grouping, and the spectral-flux
    // onset pass (~30k FFTs on a 5-minute track). The caller holds the app-wide GPU semaphore
    // across this call, and stem separation is the other consumer — so tell it to hand the GPU
    // back NOW rather than blocking separation for seconds of zero GPU work.
    (self as any).postMessage({ type: "gpu-done", id });

    let lines: OutLine[] = wordMode ? groupWords(wChunks) : cleanSegments(sChunks);

    // MEASURE, then snap. The measurement runs on the RAW Whisper times against the real vocal
    // onsets, before we touch anything — measuring after the snap would only tell us what the snap
    // did, not how wrong the model was. (Suspect the layer you didn't think was interesting.)
    const meta = pipeMeta.get(repo);
    let diag: Record<string, unknown> = {
      mode: wordMode ? "word" : "segment",
      wordError,
      model: repo,
      dtype: meta?.dtype ?? "?",
      tjs: meta?.tjs,
      lines: lines.length,
      words: 0,
      onsets: 0,
      matched: 0,
      medianLag: 0,
      madLag: 0,
      driftMsPerMin: 0,
      within160: 0,
      decodeMs: Date.now() - t0,
    };

    if (wordMode && lines.some((l) => l.words?.length)) {
      (self as any).postMessage({ type: "progress", phase: "align", id });
      const onsets = detectOnsets(audio);
      const m = measureAlignment(lines, onsets);
      diag = { ...diag, ...m, onsets: onsets.length, decodeMs: Date.now() - t0 };
      lines = snapToOnsets(lines, onsets);
    }
    (self as any).postMessage({ type: "diag", id, diag });
    (self as any).postMessage({ type: "done", id, lines, lang: language || "und" });
  } catch (err: any) {
    (self as any).postMessage({ type: "error", id, message: String(err?.message || err) });
  }
};

export {};
