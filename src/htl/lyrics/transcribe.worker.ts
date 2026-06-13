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

const UA = (typeof navigator !== "undefined" && navigator.userAgent) || "";
const WEBGPU = typeof navigator !== "undefined" && !!(navigator as any).gpu && /Chrome\/|Chromium\//.test(UA);

async function loadTjs(): Promise<any> {
  if (!tjs) {
    tjs = await import(/* @vite-ignore */ TJS);
    tjs.env.allowLocalModels = false; // models come from the HF hub, not a local /models dir
  }
  return tjs;
}

// Build (and cache) the ASR pipeline for a model repo. WebGPU/fp32 on Chromium for speed;
// wasm/q8 elsewhere for stability. Model download progress is reported to the caller.
function getPipe(repo: string): Promise<AsrPipe> {
  let p = pipes.get(repo);
  if (!p) {
    p = (async () => {
      const t = await loadTjs();
      const device = WEBGPU ? "webgpu" : "wasm";
      const dtype = WEBGPU ? "fp32" : "q8";
      return (await t.pipeline("automatic-speech-recognition", repo, {
        device,
        dtype,
        progress_callback: (e: any) => {
          if (e?.status === "progress" && typeof e.progress === "number") {
            (self as any).postMessage({ type: "progress", phase: "model", pct: Math.round(e.progress) });
          }
        },
      })) as unknown as AsrPipe;
    })();
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
    (self as any).postMessage({ type: "progress", phase: "decode", pct: 0, id });
    const audio = to16k(pcm, sampleRate);
    const common = { chunk_length_s: 30, stride_length_s: 5, ...(language ? { language } : {}) };
    // WORD-level timestamps for karaoke highlighting; if the model lacks alignment heads it
    // throws, so fall back to segment-level (line highlighting) — always produce something.
    let lines: OutLine[];
    let wordMode = false;
    try {
      const out = await pipe(audio, { return_timestamps: "word", ...common });
      const ch = out.chunks ?? [];
      // DIAGNOSTIC for word-onset drift: if the LAST word's time is far short of the audio
      // length, transformers.js isn't accumulating the per-chunk offset → words read
      // increasingly early (our/library bug). If it ≈ the audio length, per-word error is
      // the model. Compare lastWord vs audioSec in the console.
      const lastT = ch.length ? (ch[ch.length - 1].timestamp?.[0] ?? 0) : 0;
      (self as any).postMessage({
        type: "diag",
        audioSec: +(audio.length / 16000).toFixed(1),
        words: ch.length,
        lastWordSec: +lastT.toFixed(1),
        sample: ch.slice(0, 6).map((c) => [Math.round((c.timestamp?.[0] ?? 0) * 10) / 10, (c.text || "").trim()]),
      });
      lines = groupWords(ch);
      wordMode = true;
    } catch {
      const out = await pipe(audio, { return_timestamps: true, ...common });
      lines = cleanSegments(out.chunks);
    }
    // Snap word onsets to the real vocal transients (word mode only — segments have no words).
    if (wordMode && lines.some((l) => l.words?.length)) {
      (self as any).postMessage({ type: "progress", phase: "align", id });
      lines = snapToOnsets(lines, detectOnsets(audio));
    }
    (self as any).postMessage({ type: "done", id, lines, lang: language || "en" });
  } catch (err: any) {
    (self as any).postMessage({ type: "error", id, message: String(err?.message || err) });
  }
};

export {};
