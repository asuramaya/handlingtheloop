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
    try {
      const out = await pipe(audio, { return_timestamps: "word", ...common });
      lines = groupWords(out.chunks ?? []);
    } catch {
      const out = await pipe(audio, { return_timestamps: true, ...common });
      lines = cleanSegments(out.chunks);
    }
    (self as any).postMessage({ type: "done", id, lines, lang: language || "en" });
  } catch (err: any) {
    (self as any).postMessage({ type: "error", id, message: String(err?.message || err) });
  }
};

export {};
