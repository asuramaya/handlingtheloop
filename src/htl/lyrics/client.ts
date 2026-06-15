import { fetchCaptions } from "@htl/media";
import { getLyricsLocal, putLyricsLocal, deleteLyricsLocal } from "@htl/persistence";
import type { Deck } from "@htl/audio";
import type { LyricsLine, LyricsSource, LyricsTranscript } from "./types";
import type { LyricsModel } from "./models";
import { whisperModel } from "./models";
import { gpuRun } from "../stems/gpuQueue";

// Capability gate — only desktop Chromium with WebGPU runs the model locally (the same
// gate neural stems use). Everyone else still gets pooled transcripts + the YouTube
// fallback; they just never DECODE.
const UA = typeof navigator !== "undefined" ? navigator.userAgent || "" : "";
const IS_MOBILE = /Android|iPhone|iPad|iPod/i.test(UA);
const HAS_WEBGPU = typeof navigator !== "undefined" && !!(navigator as unknown as { gpu?: unknown }).gpu && /Chrome\/|Chromium\//.test(UA);
export function canTranscribe(): boolean {
  return !IS_MOBILE && HAS_WEBGPU;
}

// ---- community pool (D1) — graceful: any failure is a miss, we fall through ----------
async function poolGet(videoId: string): Promise<LyricsTranscript | null> {
  try {
    const r = await fetch(`/api/lyrics?v=${encodeURIComponent(videoId)}`);
    if (!r.ok) return null;
    const j = (await r.json()) as { transcript?: LyricsTranscript | null };
    return j?.transcript ?? null;
  } catch {
    return null;
  }
}
const postedLyrics = new Set<string>(); // contribute each track once per session (no re-writes on re-decode)
async function poolPut(t: LyricsTranscript): Promise<void> {
  if (postedLyrics.has(t.videoId)) return;
  postedLyrics.add(t.videoId);
  try {
    await fetch(`/api/lyrics`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(t),
    });
  } catch {
    /* contribution is best-effort; the local result still shows */
  }
}

// ---- the whisper worker (one, reused across decks/tracks) ----------------------------
let worker: Worker | null = null;
let seq = 0;
type Job = { resolve: (lines: LyricsLine[]) => void; reject: (e: Error) => void; onProgress?: (phase: string, pct: number) => void };
const jobs = new Map<number, Job>();

function ensureWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL("./transcribe.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent) => {
      const m = e.data;
      if (m?.type === "progress") {
        if (typeof m.id === "number") jobs.get(m.id)?.onProgress?.(m.phase, m.pct);
        else jobs.forEach((j) => j.onProgress?.(m.phase, m.pct)); // model-load progress has no id
      } else if (m?.type === "done") {
        const j = jobs.get(m.id);
        jobs.delete(m.id);
        j?.resolve((m.lines as LyricsLine[]) ?? []);
      } else if (m?.type === "error") {
        const j = jobs.get(m.id);
        jobs.delete(m.id);
        j?.reject(new Error(m.message));
      }
    };
  }
  return worker;
}

function transcribe(pcm: Float32Array, sampleRate: number, repo: string, onProgress?: (p: string, pct: number) => void): Promise<LyricsLine[]> {
  const w = ensureWorker();
  const id = ++seq;
  return new Promise((resolve, reject) => {
    jobs.set(id, { resolve, reject, onProgress });
    const buf = pcm.slice(); // COPY — the deck keeps its live stem buffer; we transfer the copy
    w.postMessage({ type: "transcribe", id, pcm: buf, sampleRate, repo }, [buf.buffer]);
  });
}

// ---- transcribe STATE MACHINE — a track is decoded at most ONCE -----------------------
// The bug this kills: every load re-ran Whisper (no persistent result + the un-deployed pool
// always misses), so a track that was "already processed" kept re-transcribing. Now: a live
// in-memory map (this session) sits over the IndexedDB cache (across refreshes), and a single
// in-flight job per videoId coalesces concurrent loads (both decks, StrictMode double-fire).
// Transcript-FORMAT version. Bump when the decode/shape changes so stale cached transcripts
// (e.g. the old segment-only [MUSIC]-laden ones) are ignored and re-decoded. 2 = word-timed +
// non-speech stripped; 3 = words carry held-duration (d); 4 = onsets snapped to vocal transients.
const LYRICS_VER = 4;
const mem = new Map<string, LyricsLine[]>(); // videoId → lines (any model — first good wins)
const inflight = new Map<string, Promise<LyricsLine[] | null>>();

// A session GUEST received the host's streamed lyrics → keep them (memory + IndexedDB) so they
// show instantly and a reload doesn't re-fetch. Same store the on-device decode + pool use, so a
// later solo play of the same track finds them. Encapsulated here to keep LYRICS_VER private.
export function cacheRemoteLyrics(videoId: string, lines: LyricsLine[], source: LyricsSource): void {
  if (!videoId || !lines?.length) return;
  mem.set(videoId, lines);
  void putLyricsLocal(videoId, { lines, model: source === "youtube" ? "youtube" : "base", ver: LYRICS_VER });
}

// User-triggered "reprocess lyrics": wipe every cached copy of this track's transcript so a
// forced resolve can't be short-circuited by a stale/contaminated entry. Clears the session
// memory, the in-flight job (so a fresh decode actually starts, not a join of the old one),
// the once-per-session pool-contribution guard, and the IndexedDB record. The shared POOL
// (D1) row is intentionally NOT deleted from here (no client auth); the forced resolve simply
// SKIPS the pool and re-decodes locally, then re-contributes the fresh result.
export async function clearLyricsCache(videoId: string): Promise<void> {
  if (!videoId) return;
  mem.delete(videoId);
  inflight.delete(videoId);
  postedLyrics.delete(videoId);
  await deleteLyricsLocal(videoId).catch(() => {});
}

async function cachedLines(videoId: string): Promise<LyricsLine[] | null> {
  const hit = mem.get(videoId);
  if (hit) return hit;
  const rec = await getLyricsLocal(videoId).catch(() => null);
  if (rec && rec.ver !== LYRICS_VER) return null; // stale format → re-decode with current logic
  const lines = rec?.lines as LyricsLine[] | undefined;
  if (lines?.length) {
    mem.set(videoId, lines);
    return lines;
  }
  return null;
}

// Run (or join) the single transcription job for this track, then persist it everywhere.
function transcribeOnce(
  videoId: string,
  deck: Deck,
  model: LyricsModel,
  sampleRate: number,
  stale: () => boolean,
  onStatus?: (m: string | null) => void,
): Promise<LyricsLine[] | null> {
  let job = inflight.get(videoId);
  if (!job) {
    job = (async () => {
      const vocals = await waitForNeuralVocals(deck, stale);
      if (!vocals) return null; // no neural vocals (Single mode / cancelled / timeout)
      const m = whisperModel(model);
      const code = m.label[0]; // Base→B, Small→S
      onStatus?.(`whisper ${code} …`);
      // Take the shared GPU queue ONLY now — the heavy WebGPU transcription — AFTER vocals are
      // ready. Acquiring it earlier would deadlock: we'd hold the GPU while waiting on the
      // separation that needs it. waitForNeuralVocals already blocked until separation released
      // the queue, so here it's free; stems↔lyrics now strictly take turns on the GPU.
      const lines = await gpuRun(() => transcribe(vocals, sampleRate, m.repo, (phase, pct) =>
        onStatus?.(
          phase === "model"
            ? `whisper ${code} ↓${pct}%`
            : phase === "align"
              ? `whisper ${code} align…`
              : `whisper ${code} ${pct}%`,
        ),
      ));
      if (lines.length) {
        mem.set(videoId, lines);
        void putLyricsLocal(videoId, { lines, model, ver: LYRICS_VER }); // survive refresh → never re-decode
        const t: LyricsTranscript = { v: 1, videoId, model, lang: "en", source: "whisper", conf: 0, lines, createdAt: Date.now() };
        void poolPut(t); // contribute to the shared pool (when deployed)
      }
      return lines;
    })();
    inflight.set(videoId, job);
    void job.finally(() => {
      if (inflight.get(videoId) === job) inflight.delete(videoId);
    });
  }
  return job;
}

// Poll until the deck holds NEURAL vocals (separation finished) — DSP vocals are too dirty
// to transcribe and would pollute the shared pool. Decoupled from deriveStems on purpose:
// one cheap property read every 1.2 s, cancelled on a new load. Returns the vocals channel,
// or null on timeout/cancel.
function waitForNeuralVocals(deck: Deck, stale: () => boolean, timeoutMs = 240000): Promise<Float32Array | null> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => {
      if (stale()) return resolve(null);
      const neural = (deck as unknown as { stemsNeural?: boolean }).stemsNeural === true;
      const ch = neural ? deck.stemChannel("vocals") : null;
      if (ch && ch.length > 16000) return resolve(ch);
      if (Date.now() - t0 > timeoutMs) return resolve(null);
      setTimeout(tick, 1200);
    };
    tick();
  });
}

export interface ResolveOpts {
  videoId: string;
  deck: Deck;
  model: LyricsModel;
  engine?: "whisper" | "youtube"; // explicit lyrics engine: Whisper (default) or YouTube captions
  force?: boolean; // user reprocess: skip the local cache AND the pool, re-decode fresh
  enabled: boolean; // settings.lyricsAuto
  sampleRate: number; // engine ctx sample rate (stems share it)
  stale: () => boolean;
  onCues: (lines: LyricsLine[], source: LyricsSource) => void; // lines carry per-word timings (Whisper)
  onStatus?: (msg: string | null) => void;
}

// Resolve a deck's lyrics. ALREADY-DECODED short-circuits first so a track is never
// re-transcribed:
//   0) local cache (this session's memory → IndexedDB) — instant, no spinner.
//   1) community pool — shared, accurate; instant and works on phones.
//   2) YouTube captions — instant placeholder / ultimate fallback while (3) decodes.
//   3) fresh on-device Whisper over the neural vocal stem (desktop GPU, decoded ONCE,
//      then cached locally + contributed to the pool). Whisper wins over the placeholder.
export async function resolveLyrics(o: ResolveOpts): Promise<void> {
  // YouTube ENGINE (explicit choice): the user wants YouTube's captions, full stop — no pool, no
  // on-device decode, no GPU. Skip even the local Whisper cache so the engine choice is honoured
  // predictably. Works everywhere (mobile included).
  if (o.engine === "youtube") {
    if (o.force) await clearLyricsCache(o.videoId); // wipe any bad cached whisper copy too
    const cues = await fetchCaptions(o.videoId);
    if (o.stale()) return;
    if (cues.length) {
      o.onCues(cues, "youtube");
    } else {
      o.onStatus?.("No YouTube captions");
      setTimeout(() => !o.stale() && o.onStatus?.(null), 4000);
    }
    return;
  }

  // A forced reprocess (the user got wrong/contaminated lyrics) wipes every cached copy first
  // and SKIPS both the local cache (step 0) and the pool (step 1) — those are exactly what
  // served the bad transcript — going straight to a fresh on-device decode below.
  if (o.force) {
    await clearLyricsCache(o.videoId);
  } else {
    // 0) Local cache — the fix for the re-transcribe loop. If we've decoded this track before
    // (this session OR a past one), use it and STOP. No vocals wait, no worker, no spinner.
    const cached = await cachedLines(o.videoId);
    if (o.stale()) return;
    if (cached) {
      o.onCues(cached, "whisper");
      return;
    }

    // 1) Community pool.
    const pooled = await poolGet(o.videoId);
    if (o.stale()) return;
    if (pooled?.lines?.length) {
      mem.set(o.videoId, pooled.lines);
      void putLyricsLocal(o.videoId, { lines: pooled.lines, model: pooled.model, ver: LYRICS_VER });
      o.onCues(pooled.lines, "pool");
      return;
    }
  }

  // 2) YouTube captions — the instant placeholder AND the guaranteed fallback. Kick the
  // fetch off now so it overlaps the neural-vocals wait, but DON'T fire-and-forget the
  // result: keep the promise so every path that ends WITHOUT Whisper lyrics can still
  // surface YouTube. The old code lost this promise, so a Whisper skip/miss/error (and
  // the long no-neural-vocals timeout) went silently blank instead of showing captions.
  let whisperWon = false;
  const youtube = fetchCaptions(o.videoId).catch(() => []);
  void youtube.then((cues) => {
    if (o.stale() || whisperWon || !cues.length) return;
    o.onCues(cues, "youtube"); // show immediately; Whisper overrides it if it wins
  });

  // The ONE place every "no Whisper lyrics" path funnels through: await the SAME caption
  // fetch and show it, or surface a clear status when there's genuinely nothing anywhere.
  const fallbackToYouTube = async (emptyMsg: string): Promise<void> => {
    const cues = await youtube;
    if (o.stale() || whisperWon) return;
    if (cues.length) {
      o.onCues(cues, "youtube");
    } else {
      o.onStatus?.(emptyMsg);
      setTimeout(() => !o.stale() && o.onStatus?.(null), 4000);
    }
  };

  // 3) Fresh Whisper over the neural vocal stem (desktop Chromium + WebGPU only). The
  // single-flight job persists the result, so this branch runs at most once per track.
  // Whisper off, or this device can't decode → YouTube is the answer, not silence.
  if (!o.enabled || !canTranscribe()) return fallbackToYouTube("No lyrics found");
  try {
    const lines = await transcribeOnce(o.videoId, o.deck, o.model, o.sampleRate, o.stale, o.onStatus);
    if (o.stale()) return;
    if (lines == null) return fallbackToYouTube("No lyrics found"); // no neural vocals / cancelled
    if (!lines.length) return fallbackToYouTube("No lyrics detected"); // Whisper ran, found nothing
    o.onStatus?.(null);
    whisperWon = true;
    o.onCues(lines, "whisper"); // full lines incl. per-word timings
  } catch (err) {
    // Worker / model load / WebGPU failed — fall back to YouTube, not a dead "unavailable".
    console.warn("[htl] lyric transcription failed:", err);
    await fallbackToYouTube("Lyrics unavailable");
  }
}
