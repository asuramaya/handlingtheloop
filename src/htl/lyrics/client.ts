import { fetchCaptions } from "@htl/media";
import { getLyricsLocal, putLyricsLocal, deleteLyricsLocal } from "@htl/persistence";
import type { Deck } from "@htl/audio";
import type { LyricsDiag, LyricsLine, LyricsSource, LyricsTranscript } from "./types";
import type { LyricsModel } from "./models";
import { whisperModel } from "./models";
import { planLyrics, looksDegenerate } from "./convergence";
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

// Transcript-FORMAT version. Bump when the decode/shape changes so stale transcripts are
// re-decoded instead of served forever. 1 = segment-only; 2 = word-timed + non-speech
// stripped; 3 = words carry held-duration (d); 4 = onsets snapped to vocal transients (a ±160 ms
// nearest-onset snap that, on sung vocals, mostly reached nothing); 5 = FORCED ALIGNMENT — the word
// sequence is fitted to the real vocal onsets as a whole (systematic offset + drift removed, then a
// monotonic assignment), so the TIMES no longer come from Whisper at all.
//
// ★ This bump is the convergence contract's first real job: every v4 transcript — local and pooled —
// is now behind, so the next capable device re-decodes it with the aligner and upgrades the row for
// everyone. That is the machinery working exactly as designed.
//
// ★ THIS NUMBER TRAVELS. It is stamped into the IndexedDB record AND into the shared D1 pool
// row (migration 0026), and the rule is the same in both places — the one the analysis dataset
// already uses for beatgrids: REUSE a stored transcript only when its version is >= ours;
// otherwise re-decode and UPGRADE it. The pool's don't-downgrade upsert means a write can only
// ever move a row forward. Before 0026 the pool had no version at all, so a stale transcript was
// served to every client, stamped current on the way into the local cache, and never re-decoded
// — bumping this constant did nothing for any track that was already pooled.
const LYRICS_VER = 5;

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
type Job = {
  resolve: (lines: LyricsLine[]) => void;
  reject: (e: Error) => void;
  onProgress?: (phase: string, pct: number) => void;
  onGpuDone?: () => void; // the GPU phase is over; the CPU align pass is still running
  onDiag?: (d: LyricsDiag) => void; // the alignment measurement (see LyricsDiag)
};
const jobs = new Map<number, Job>();

// The last alignment measurement per track — the answer to "are the lyrics even firing, and if
// they are, WHY don't they line up?". Surfaced in Settings ▸ Debug ▸ Lyrics. Kept out of the
// transcript itself: it describes THIS decode, not the lyrics.
const diags = new Map<string, LyricsDiag>();
export function getLyricsDiag(videoId: string): LyricsDiag | null {
  return diags.get(videoId) ?? null;
}

function ensureWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL("./transcribe.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent) => {
      const m = e.data;
      if (m?.type === "progress") {
        if (typeof m.id === "number") jobs.get(m.id)?.onProgress?.(m.phase, m.pct);
        else jobs.forEach((j) => j.onProgress?.(m.phase, m.pct)); // model-load progress has no id
      } else if (m?.type === "gpu-done") {
        jobs.get(m.id)?.onGpuDone?.(); // decode finished — hand the GPU back before we align
      } else if (m?.type === "diag") {
        jobs.get(m.id)?.onDiag?.(m.diag as LyricsDiag);
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

function transcribe(
  pcm: Float32Array,
  sampleRate: number,
  repo: string,
  onProgress?: (p: string, pct: number) => void,
  onGpuDone?: () => void,
  onDiag?: (d: LyricsDiag) => void,
): Promise<LyricsLine[]> {
  const w = ensureWorker();
  const id = ++seq;
  return new Promise((resolve, reject) => {
    jobs.set(id, { resolve, reject, onProgress, onGpuDone, onDiag });
    const buf = pcm.slice(); // COPY — the deck keeps its live stem buffer; we transfer the copy
    w.postMessage({ type: "transcribe", id, pcm: buf, sampleRate, repo }, [buf.buffer]);
  });
}

// ---- transcribe STATE MACHINE — a track is decoded at most ONCE -----------------------
// The bug this kills: every load used to re-run Whisper (no persistent result + the un-deployed
// pool always missed), so a track that was "already processed" kept re-transcribing. Now: a live
// in-memory map (this session) sits over the IndexedDB cache (across refreshes), and a single
// in-flight job per videoId coalesces concurrent loads (both decks, StrictMode double-fire).
const mem = new Map<string, LyricsLine[]>(); // videoId → lines (any model — first good wins)
const inflight = new Map<string, Promise<LyricsLine[] | null>>();

// Every deck currently waiting on the SAME track's transcript. The single-flight job used to
// capture the FIRST caller's deck and stale-check, so if that deck changed track the shared job
// resolved null — and a second deck still holding the track got nothing. The job now polls
// whichever waiter is still live, and only gives up when ALL of them are stale.
interface Waiter {
  deck: Deck;
  stale: () => boolean;
  stemsEnabled: boolean; // is this deck ever going to produce a neural vocal stem?
}
const waiters = new Map<string, Set<Waiter>>();

// Forced-reprocess generation, per track. A decode that started BEFORE the user hit 🎤↻ is
// carrying exactly the lines they rejected; if it lands after the wipe it must not write them
// anywhere. Bumping the generation orphans that job: it returns null and persists nothing.
const gen = new Map<string, number>();
const genOf = (videoId: string) => gen.get(videoId) ?? 0;

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
// memory, the in-flight job, the once-per-session pool-contribution guard, and the IndexedDB
// record — and BUMPS THE GENERATION, which is what actually neutralises a decode that is already
// running: without it, the orphaned job completed and wrote the rejected lines straight back into
// the cache and (since the postedLyrics guard had just been cleared) into the shared POOL.
// The pool row itself is not deleted from here (no client auth); the forced resolve SKIPS the
// pool and re-decodes, then re-contributes the fresh result, which the don't-downgrade upsert
// accepts because its version is equal-or-newer.
export async function clearLyricsCache(videoId: string): Promise<void> {
  if (!videoId) return;
  gen.set(videoId, genOf(videoId) + 1);
  mem.delete(videoId);
  inflight.delete(videoId);
  postedLyrics.delete(videoId);
  await deleteLyricsLocal(videoId).catch(() => {});
}

/** The best transcript already on this device, with the format version that produced it. */
async function cachedLocal(videoId: string): Promise<{ lines: LyricsLine[]; ver: number } | null> {
  const hit = mem.get(videoId);
  if (hit) return { lines: hit, ver: LYRICS_VER }; // this session decoded/adopted it → current by construction
  const rec = await getLyricsLocal(videoId).catch(() => null);
  const lines = rec?.lines as LyricsLine[] | undefined;
  if (!lines?.length) return null;
  return { lines, ver: (rec as { ver?: number })?.ver ?? 1 };
}

// Run (or join) the single transcription job for this track, then persist it everywhere.
function transcribeOnce(
  videoId: string,
  waiter: Waiter,
  model: LyricsModel,
  sampleRate: number,
  onStatus?: (m: string | null) => void,
): Promise<LyricsLine[] | null> {
  const set = waiters.get(videoId) ?? new Set<Waiter>();
  set.add(waiter);
  waiters.set(videoId, set);

  let job = inflight.get(videoId);
  if (!job) {
    const bornAt = genOf(videoId); // the generation this decode belongs to
    job = (async () => {
      const vocals = await waitForNeuralVocals(videoId, onStatus);
      if (!vocals) return null; // no neural vocals (Single mode / cancelled / timeout)
      const m = whisperModel(model);
      const code = m.label[0]; // Base→B, Small→S
      onStatus?.(`whisper ${code} …`);

      // Take the shared GPU queue ONLY now — AFTER vocals are ready. Acquiring it earlier would
      // deadlock: we'd hold the GPU while waiting on the separation that needs it.
      //
      // ★ And hold it for the DECODE ONLY. The worker's last act is a CPU-only onset-alignment
      // pass (spectral flux over the whole stem, ~30k FFTs on a 5-minute track); holding the
      // semaphore through it blocks stem separation for seconds of ZERO GPU work. The worker
      // signals `gpu-done` when its GPU phase ends and we release there.
      // SAFETY: the gate also resolves when the job settles either way. A stranded lock here
      // would stop ALL stem separation app-wide, so it must be impossible to leave one behind —
      // an error, or a worker that never sends the signal, still frees the queue.
      let releaseGpu!: () => void;
      const gpuPhase = new Promise<void>((r) => {
        releaseGpu = r;
      });
      let decode!: Promise<LyricsLine[]>;
      await gpuRun(() => {
        decode = transcribe(
          vocals,
          sampleRate,
          m.repo,
          (phase, pct) =>
            onStatus?.(
              phase === "model"
                ? `whisper ${code} ↓${pct}%`
                : phase === "align"
                  ? `whisper ${code} align…`
                  : `whisper ${code} ${pct}%`,
            ),
          releaseGpu,
          (d) => diags.set(videoId, d), // keep the measurement even if the caller goes stale
        );
        decode.then(releaseGpu, releaseGpu); // belt-and-braces: never strand the queue
        return gpuPhase;
      });
      const lines = await decode;

      // Superseded by a forced reprocess while we were decoding → these are the very lines the
      // user rejected. Persist nothing, publish nothing, return nothing.
      if (genOf(videoId) !== bornAt) return null;

      if (lines.length) {
        mem.set(videoId, lines);
        void putLyricsLocal(videoId, { lines, model, ver: LYRICS_VER }); // survive refresh → never re-decode
        // A degenerate result is still cached LOCALLY — the decode-once state machine depends on
        // it, or the track re-decodes on every load forever — but it must never reach the shared
        // pool, where it would be served to every other device. The 🎤↻ button is the user's out.
        if (!looksDegenerate(lines)) {
          const t: LyricsTranscript = {
            v: 1,
            videoId,
            model,
            lang: "und", // the decoder auto-detects and doesn't report back — don't file a guess as fact
            source: "whisper",
            conf: 0, // 0 = unknown (the pipeline gives us no usable logprob)
            ver: LYRICS_VER, // ← the stamp that lets the pool converge instead of ratchet down
            lines,
            createdAt: Date.now(),
          };
          void poolPut(t);
        }
      }
      return lines;
    })();
    inflight.set(videoId, job);
    const created = job;
    void created.finally(() => {
      if (inflight.get(videoId) === created) inflight.delete(videoId);
    });
  }
  // EVERY caller drops its OWN waiter when the shared job settles — not just the one that created
  // it. (Registering the cleanup inside the `if (!job)` block above would leak the waiters of
  // every deck that JOINED an in-flight decode.) The returned promise carries the job's value.
  return job.finally(() => {
    const s = waiters.get(videoId);
    if (!s) return;
    s.delete(waiter);
    if (!s.size) waiters.delete(videoId);
  });
}

// How long to wait for a vocal stem that separation is actually working on...
const VOCALS_TIMEOUT_MS = 240000;
// ...versus how long to wait when NO waiting deck has separation enabled. The stem can still
// arrive (a cached neural set auto-promotes on desktop even in "Single" mode), so we don't
// refuse outright — we give it a short grace and then say plainly why there are no lyrics,
// instead of sitting silent for four minutes. That silence was the whole "the engine seems to
// hang" report: Whisper needs a neural vocal stem, and stem separation is OFF by default.
const VOCALS_NO_STEMS_MS = 20000;

// Poll until SOME live waiter's deck holds NEURAL vocals (separation finished) — DSP vocals are
// too dirty to transcribe and would pollute the shared pool. Decoupled from deriveStems on
// purpose: one cheap property read every 1.2 s. Gives up when every waiter has gone stale.
function waitForNeuralVocals(videoId: string, onStatus?: (m: string | null) => void): Promise<Float32Array | null> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let announced = false;
    const tick = () => {
      const live = [...(waiters.get(videoId) ?? [])].filter((w) => !w.stale());
      if (!live.length) return resolve(null); // every deck that wanted this track has moved on

      for (const w of live) {
        const neural = (w.deck as unknown as { stemsNeural?: boolean }).stemsNeural === true;
        const ch = neural ? w.deck.stemChannel("vocals") : null;
        if (ch && ch.length > 16000) return resolve(ch);
      }

      // Never wait in silence — the vocal stem is a real dependency and the user can act on it.
      const separating = live.some((w) => w.stemsEnabled);
      if (!announced) {
        announced = true;
        onStatus?.(separating ? "whisper — waiting for the vocal stem…" : "whisper — needs stem separation");
      }
      const limit = separating ? VOCALS_TIMEOUT_MS : VOCALS_NO_STEMS_MS;
      if (Date.now() - t0 > limit) return resolve(null);
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
  stemsEnabled?: boolean; // settings.stemModel !== "off" — is a neural vocal stem even coming?
  sampleRate: number; // engine ctx sample rate (stems share it)
  stale: () => boolean;
  onCues: (lines: LyricsLine[], source: LyricsSource) => void; // lines carry per-word timings (Whisper)
  onStatus?: (msg: string | null) => void;
}

// Resolve a deck's lyrics. ALREADY-DECODED short-circuits first so a track is never
// re-transcribed:
//   0) the best transcript already on hand — local cache, else the community pool.
//      ★ Reused only if its FORMAT VERSION is at least ours. An older one is still SHOWN (stale
//      lyrics beat no lyrics, and a phone can't do better) but a device that CAN decode re-runs
//      Whisper and upgrades the shared row, so the pool heals for everyone.
//   1) YouTube captions — instant placeholder / ultimate fallback while (2) decodes.
//   2) fresh on-device Whisper over the neural vocal stem (desktop GPU, decoded ONCE,
//      then cached locally + contributed to the pool). Whisper stomps the placeholder.
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
      o.onStatus?.(null);
    } else {
      o.onStatus?.("No YouTube captions");
      setTimeout(() => !o.stale() && o.onStatus?.(null), 4000);
    }
    return;
  }

  // A forced reprocess (the user got wrong/contaminated lyrics) wipes every cached copy first and
  // SKIPS both the local cache and the pool — those are exactly what served the bad transcript.
  if (o.force) await clearLyricsCache(o.videoId);

  // 0) The best transcript already stored — locally, else in the pool — and how OLD its format is.
  let local: { lines: LyricsLine[]; ver: number } | null = null;
  let pooled: LyricsTranscript | null = null;
  if (!o.force) {
    local = await cachedLocal(o.videoId);
    if (o.stale()) return;
    // Only bother the pool when what we hold is missing or BEHIND — it may have been upgraded by
    // someone else's GPU since we cached ours.
    if (!local || local.ver < LYRICS_VER) {
      pooled = await poolGet(o.videoId);
      if (o.stale()) return;
    }
  }

  // The reuse-vs-recompute gate (pure + tested — see convergence.ts). Reuse a stored transcript
  // iff its format is at least ours; otherwise show it and re-decode to UPGRADE it, here and in
  // the pool. A device that can't decode keeps the stale copy rather than blanking the ribbon.
  const plan = planLyrics({
    local: local?.ver ?? null,
    pooled: pooled?.lines?.length ? (pooled.ver ?? 1) : null,
    clientVer: LYRICS_VER,
    canDecode: o.enabled && canTranscribe(),
  });

  let best: { lines: LyricsLine[]; source: LyricsSource } | null = null;
  if (plan.show === "pool" && pooled?.lines?.length) {
    best = { lines: pooled.lines, source: "pool" };
    mem.set(o.videoId, pooled.lines);
    if (plan.adoptPool) {
      // Stamp its TRUE version, not ours. Stamping the current version onto an old transcript is
      // exactly how the pool used to defeat this gate — the stale copy looked fresh forever.
      void putLyricsLocal(o.videoId, { lines: pooled.lines, model: pooled.model, ver: pooled.ver ?? 1 });
    }
  } else if (plan.show === "local" && local) {
    best = { lines: local.lines, source: "whisper" };
  }

  if (best) {
    o.onCues(best.lines, best.source);
    o.onStatus?.(null);
    if (!plan.decode) return; // current format, or this device can't do better → done
  }

  // 1) YouTube captions — the instant placeholder AND the guaranteed fallback. Kick the fetch off
  // now so it overlaps the neural-vocals wait, but DON'T fire-and-forget the result: keep the
  // promise so every path that ends WITHOUT Whisper lyrics can still surface captions.
  let whisperWon = false;
  const youtube = fetchCaptions(o.videoId).catch(() => []);
  void youtube.then((cues) => {
    if (o.stale() || whisperWon || best || !cues.length) return; // never stomp a real transcript
    o.onCues(cues, "youtube"); // show immediately; Whisper overrides it if it wins
  });

  // The ONE place every "no Whisper lyrics" path funnels through. `note` explains WHY when the
  // reason is actionable (no vocal stem), and outlives the captions so the user still sees it.
  const fallbackToYouTube = async (emptyMsg: string, note?: string): Promise<void> => {
    const cues = await youtube;
    if (o.stale() || whisperWon) return;
    const showed = best ? true : cues.length > 0;
    if (!best && cues.length) o.onCues(cues, "youtube");
    if (note || !showed) {
      o.onStatus?.(note || emptyMsg);
      setTimeout(() => !o.stale() && o.onStatus?.(null), 5000);
    } else {
      o.onStatus?.(null);
    }
  };

  // 2) Fresh Whisper over the neural vocal stem (desktop Chromium + WebGPU only). The single-
  // flight job persists the result, so this branch runs at most once per track.
  if (!plan.decode) return fallbackToYouTube("No lyrics found"); // lyrics off, or this device can't decode
  try {
    const waiter: Waiter = { deck: o.deck, stale: o.stale, stemsEnabled: o.stemsEnabled !== false };
    const lines = await transcribeOnce(o.videoId, waiter, o.model, o.sampleRate, o.onStatus);
    if (o.stale()) return;
    if (lines == null) {
      // No neural vocals. If separation isn't even on, say so — it's the actual fix, and it used
      // to be four minutes of nothing.
      const note = o.stemsEnabled === false ? "Whisper lyrics need stem separation — turn it on in Settings ▸ Audio" : undefined;
      return fallbackToYouTube("No lyrics found", note);
    }
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
