import { fetchCaptions } from "@htl/media";
import { identifyTrack } from "@htl/media";
import { getLyricsLocal, putLyricsLocal, deleteLyricsLocal } from "@htl/persistence";
import type { Deck } from "@htl/audio";
import type { LyricsDiag, LyricsLine, LyricsSource, LyricsTranscript } from "./types";
import { fetchLrcLib, lrcToLines } from "./lrclib";
import { planLyrics } from "./convergence";
import type { LrcReport } from "./lrcAlign";

// ★ THE PIPELINE, AFTER TWO SESSIONS OF GETTING IT WRONG:
//
//    LRCLIB      →  WHAT was sung      (a published fact — not something to infer from audio)
//    vocal stem  →  WHEN it was sung   (a measurement — the thing we're actually equipped to do)
//
// Whisper used to supply the words, and it hallucinated: a generative model samples the next token
// conditioned on audio it finds ambiguous, and sung vowels are maximally ambiguous. No model size
// fixes that (large-v3-turbo failed too) because inventing words is IN ITS OUTPUT SPACE. Forced
// alignment structurally cannot: you hand it the words, and it only answers WHERE each one sits.
//
// ★ AND IT DEGRADES ALL THE WAY DOWN. LRCLIB's line timings are useful ON THEIR OWN — no stem, no
// model, no GPU, no download. So a phone gets line-synced lyrics instantly, and a desktop with a
// neural vocal stem UPGRADES them to word-level. Lyrics no longer need anything switched on to work,
// which is what finally kills the "feature shipped in the off position" problem.

// Transcript-FORMAT version. Bump when the shape OR THE DERIVATION changes, so stored rows are
// re-derived instead of served forever.
//   1-4  Whisper eras.
//   5    Whisper + forced alignment to onsets.
//   6    ★ LRCLIB words + vocal-stem times — the words became GROUND TRUTH instead of a guess.
//   7    ★ alignment moved into VOICED time (10dcf22). A v6 row was aligned by the version that
//        seeded words across a line's WALL clock, so on any song with instrumental bars inside a
//        line (Rammstein's "Du, du hast, du hast mich") the whole line collapsed onto its last
//        word. Same words, badly placed — and a v6 stamp said "current", so it would have been
//        reused forever. ⚠ I FIXED THE DERIVATION AND ALMOST DIDN'T BUMP THIS. The convergence
//        contract only works if the version tracks the OUTPUT, not just the schema: if the same
//        input can now produce different times, it is a new version.
//   8    ★★ AND I DID IT AGAIN — the exact mistake #7's own comment warns about, twice in one
//        session, before the operator's own re-test caught it (the transcript kept serving
//        "same bug, not fixed yet" off a v7-stamped row, because nothing told the cache the
//        derivation had changed). Two real derivation fixes landed as v7 by mistake: seedOnBursts
//        (5cc8ab5, replaces the flat seedOnAttacks split with burst-partitioned seeding) and the
//        voicedClock.toWall floor (28bf60e, a word seeded at a track's own singing-start could get
//        pushed to a negative voiced-time and collapse to wall-clock zero). Both are real, both
//        change actual output for real tracks (Du Hast, Coax & Botany), and neither could reach a
//        single user until this bump forces every stored v7 row to re-derive.
//   9    ★ the whole-track shift became RESCUE-OR-POLISH (decideShift). v8's re-derive exposed it
//        live on Britney's "I Wanna Go": the LRC clock was already right (first line 9.04, voice at
//        9.25), but "shift whenever coverage improves at all" let a +1.15 s yank win on a 3-line
//        coverage gain — noise on a 50-line song — and every v8 line sat seconds behind the singer.
//        A credible clock may now move at most 0.5 s; the full shift survives only for the
//        different-cut case (as-is coverage below the trust bar). Every v8 `aligned` row was built
//        under the old rule and must re-derive.
//   10   ★ plain lyrics got ANCHORS (assignLinesToRuns): lines are assigned to the mask's own
//        voiced runs — a dense line may not sit on a burst it can't physically fit, and a burst the
//        sheet doesn't print a line for may hold NOTHING — then handed to the anchored alignLrc
//        path. Kills the measured Coax & Botany failure where every unprinted "oh-whoa" repeat
//        dragged the following printed line one burst early (the verse-3 reprise showed a whole
//        silence-gap before it was sung). Every `estimated` row predates this and must re-derive.
//   11   ★ the offset search can now actually REACH a far-away truth, and a yank must be DECISIVE.
//        Britney's video sings the whole song +37.5s behind an interview whose SPEECH sits in the
//        vocal stem (a mask cannot tell speech from singing, so the wrong clock looked credible);
//        the true peak (coverage 0.68→0.98, dice 0.43→0.63, both measured) was unreachable behind a
//        ±30s search fence, an uncapped distance penalty, and v9's own never-yank-a-credible-clock
//        rule. Search now extends to the clocks' real slack, the penalty is capped at repetition
//        scale, and decideShift takes a big offset iff the coverage gain is decisive (≥0.15).
//        Plus: the onset edge-tolerance (v10) admitted htdemucs pre-echo onsets and slid Du Hast's
//        words a slot early — edge onsets now dedupe against the run's own first attack.
const LYRICS_VER = 11;

// ★ BELOW THIS, A TRANSCRIPT IS NOT STALE — IT IS FICTION, AND MUST NEVER BE SHOWN.
//
// The convergence contract's rule is "a stale transcript beats no transcript: show it, and re-derive
// underneath". That is right when stale means WORSE TIMING. It is dead wrong for the Whisper era,
// where the WORDS THEMSELVES WERE INVENTED — the cached dev pool is full of "(crow cawing) (crow
// cawing) (crow cawing)". Displaying that for even a second, while a correct version derives behind
// it, is showing the user a lie. So a v≤5 row is not adopted, not shown, and not kept: it is deleted
// on sight. "Something beats nothing" stops being true the moment the something is made up.
const FIRST_TRUSTWORTHY_VER = 6;

// ---- community pool (D1) — graceful: any failure is a miss, we fall through ----------
async function poolGet(videoId: string): Promise<LyricsTranscript | null> {
  try {
    const r = await fetch(`/api/lyrics?v=${encodeURIComponent(videoId)}`);
    if (!r.ok) return null;
    const j = (await r.json()) as { transcript?: LyricsTranscript | null };
    const t = j?.transcript ?? null;
    // A pooled Whisper transcript is invented words. Refuse it outright — don't show it, don't
    // adopt it, don't let it beat "nothing". (The server drops these too; this is the client half,
    // because an old deployed worker is exactly the thing you cannot patch retroactively.)
    if (t && (t.ver ?? 1) < FIRST_TRUSTWORTHY_VER) return null;
    return t;
  } catch {
    return null;
  }
}
const postedLyrics = new Set<string>(); // contribute each track once per session
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

// ---- the alignment worker (CPU DSP only — no model, no GPU) --------------------------
let worker: Worker | null = null;
let seq = 0;
type Job = {
  resolve: (r: { lines: LyricsLine[]; report: LrcReport; onsets: number }) => void;
  reject: (e: Error) => void;
  onProgress?: (phase: string, pct: number) => void;
};
const jobs = new Map<number, Job>();

const diags = new Map<string, LyricsDiag>();
export function getLyricsDiag(videoId: string): LyricsDiag | null {
  return diags.get(videoId) ?? null;
}

/** Alignment runs on the CPU now, so there is no capability gate worth the name — but a phone that
 *  never separates has no vocal stem to align against, and gets LRCLIB's line timings as-is. */
export function canAlign(): boolean {
  return typeof Worker !== "undefined";
}

function ensureWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL("./analyze.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent) => {
      const m = e.data;
      if (m?.type === "progress") {
        if (typeof m.id === "number") jobs.get(m.id)?.onProgress?.(m.phase, m.pct);
      } else if (m?.type === "done") {
        const j = jobs.get(m.id);
        jobs.delete(m.id);
        j?.resolve({ lines: m.lines as LyricsLine[], report: m.report as LrcReport, onsets: m.onsets as number });
      } else if (m?.type === "error") {
        const j = jobs.get(m.id);
        jobs.delete(m.id);
        j?.reject(new Error(m.message));
      }
    };
  }
  return worker;
}

function alignOnWorker(
  pcm: Float32Array,
  sampleRate: number,
  words: { lines?: LyricsLine[]; plain?: string[] },
  duration: number,
  onProgress?: (p: string, pct: number) => void,
): Promise<{ lines: LyricsLine[]; report: LrcReport; onsets: number }> {
  const w = ensureWorker();
  const id = ++seq;
  return new Promise((resolve, reject) => {
    jobs.set(id, { resolve, reject, onProgress });
    const buf = pcm.slice(); // COPY — the deck keeps its live stem buffer; we transfer the copy
    w.postMessage({ type: "align", id, pcm: buf, sampleRate, ...words, duration }, [buf.buffer]);
  });
}

// ★ BOUNDED, BUT PER REQUEST — NOT PER CHAIN. A `fetch` with no timeout does not fail, it HANGS,
// and a hung lookup leaves the spinner turning for the rest of the session. But my first cut wrapped
// the WHOLE three-request lookup in one 10 s budget, and LRCLIB is genuinely slow: /get takes ~4 s
// and /search ~9 s (measured). So a lookup that was going to SUCCEED got aborted mid-chain, and the
// diagnostic then told the operator "LRCLIB has never seen this recording" — a timeout reported as a
// miss, which is the worst kind of wrong answer because it sends you looking in the wrong place.
// A budget must bound ONE thing that can hang, not a sequence of things that are merely slow.
// The outer ceiling: a HANG guard for the whole lookup, not a race against a slow service.
// Each request inside fetchLrcLib carries its own 15 s budget (see lrclib.ts).
const NET_TIMEOUT_MS = 45000;
async function bounded<T>(fn: (signal: AbortSignal) => Promise<T>, fallback: T, onFail?: () => void): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), NET_TIMEOUT_MS);
  try {
    return await fn(ctrl.signal);
  } catch {
    onFail?.(); // ★ a lookup that FAILED is not a lookup that MISSED — the diagnostic must not conflate them
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

// ---- caches --------------------------------------------------------------------------
const mem = new Map<string, LyricsLine[]>();
// The provenance of whatever's in `mem` — a SEPARATE map, not a guess. It used to be hardcoded
// "aligned" at every read site regardless of how the lines were actually derived, so a track with
// no LRCLIB line clock (alignPlain's "estimated" — the weakest, no-anchors case) displayed its
// debug source as the STRONGEST possible one. Real bug, found on "Coax & Botany".
const memSource = new Map<string, LyricsSource>();
const SOURCES: readonly LyricsSource[] = ["lrclib", "aligned", "estimated", "pool", "youtube"];
const asSource = (s: string | undefined): LyricsSource => (SOURCES as readonly string[]).includes(s ?? "") ? (s as LyricsSource) : "pool";
const inflight = new Map<string, Promise<LyricsLine[] | null>>();
const gen = new Map<string, number>();
const genOf = (v: string) => gen.get(v) ?? 0;

export function cacheRemoteLyrics(videoId: string, lines: LyricsLine[], source: LyricsSource): void {
  if (!videoId || !lines?.length) return;
  mem.set(videoId, lines);
  memSource.set(videoId, source);
  void putLyricsLocal(videoId, { lines, model: source, ver: LYRICS_VER });
}

export async function clearLyricsCache(videoId: string): Promise<void> {
  if (!videoId) return;
  gen.set(videoId, genOf(videoId) + 1);
  mem.delete(videoId);
  memSource.delete(videoId);
  inflight.delete(videoId);
  postedLyrics.delete(videoId);
  await deleteLyricsLocal(videoId).catch(() => {});
}

async function cachedLocal(videoId: string): Promise<{ lines: LyricsLine[]; ver: number; source: LyricsSource } | null> {
  const hit = mem.get(videoId);
  if (hit) return { lines: hit, ver: LYRICS_VER, source: memSource.get(videoId) ?? "pool" };
  const rec = await getLyricsLocal(videoId).catch(() => null);
  const lines = rec?.lines as LyricsLine[] | undefined;
  if (!lines?.length) return null;
  const ver = (rec as { ver?: number })?.ver ?? 1;
  // ★ SELF-CLEANING. Whisper-era rows are sitting in every user's IndexedDB from before the rebuild,
  // and they are invented words, not stale ones. Delete on sight — there is no migration to run and
  // nothing for the user to clear; the cache repairs itself the first time each track is touched.
  if (ver < FIRST_TRUSTWORTHY_VER) {
    void deleteLyricsLocal(videoId).catch(() => {});
    return null;
  }
  return { lines, ver, source: asSource(rec?.model) };
}

// ---- the vocal stem ------------------------------------------------------------------
// How long to wait for a stem that separation is actually working on...
const VOCALS_TIMEOUT_MS = 240000;
// ...versus when no waiting deck has separation on. We no longer NEED the stem (LRCLIB's line times
// stand on their own), so this is short: take what we have and move on.
const VOCALS_NO_STEMS_MS = 8000;

interface Waiter {
  deck: Deck;
  stale: () => boolean;
  stemsEnabled: boolean;
}
const waiters = new Map<string, Set<Waiter>>();

/** Poll until some live waiter's deck holds a NEURAL vocal stem FOR THIS TRACK. Asks the DECK for
 *  the PCM (vocalPcm) — never `stemChannel`, which reads a float32 buffer the deck frees on purpose
 *  (that bug meant Whisper waited out a four-minute timeout on a deleted buffer, every single time). */
function waitForNeuralVocals(videoId: string, onStatus?: (m: string | null) => void): Promise<Float32Array | null> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let announced = false;
    const tick = async () => {
      const live = [...(waiters.get(videoId) ?? [])].filter((w) => !w.stale());
      if (!live.length) return resolve(null);
      for (const w of live) {
        const pcm = await w.deck.vocalPcm(videoId).catch(() => null);
        if (pcm && pcm.length > 16000) return resolve(pcm);
      }
      const separating = live.some((w) => w.stemsEnabled);
      if (!announced && separating) {
        announced = true;
        onStatus?.("lyrics — waiting for the vocal stem…");
      }
      const limit = separating ? VOCALS_TIMEOUT_MS : VOCALS_NO_STEMS_MS;
      if (Date.now() - t0 > limit) return resolve(null);
      setTimeout(() => void tick(), 1200);
    };
    void tick();
  });
}

// ---- identity: which song IS this? ---------------------------------------------------
// ★ We do NOT re-derive this. The app already fingerprints tracks (Chromaprint → AcoustID →
// MusicBrainz) to get a canonical artist/title/ISRC for the recommender, cached globally in D1. That
// is exactly LRCLIB's input contract, and it is far better than scraping a YouTube title like
// "Artist - Song (Official Video) [4K Remastered]". A capability built for one feature is rarely
// specific to it: identity is a property of the TRACK, not of the recommender.
async function canonicalName(videoId: string, fallbackTitle?: string): Promise<{ artist: string; title: string } | null> {
  const probe = await identifyTrack(videoId, null, 0).catch(() => null); // cache probe — free, no decode
  const id = probe?.identity;
  if (id?.artist && id?.title) return { artist: id.artist, title: id.title };
  // Not identified (about 1 in 5). Fall back to splitting the uploader's title on the usual dash.
  const t = (fallbackTitle ?? "").replace(/\s*[([].*?[)\]]/g, "").trim();
  const m = t.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  return m ? { artist: m[1].trim(), title: m[2].trim() } : null;
}

export interface ResolveOpts {
  videoId: string;
  deck: Deck;
  /** The uploader's title — the fallback when acoustic identity has no match for this track. */
  trackTitle?: string;
  /** Track length, seconds. ★ MUST come from the track METADATA, not from `deck.duration`: lyrics
   *  resolve starts BEFORE the audio is decoded, so the deck's duration is 0 (or the last track's).
   *  It reads as a harmless default and it is not — LRCLIB's exact /get is duration-matched, so a
   *  zero here SKIPS the fast, precise lookup and falls through to the slow fuzzy search. */
  duration?: number;
  engine?: "lrclib" | "youtube";
  force?: boolean;
  enabled: boolean; // settings.lyricsAuto
  stemsEnabled?: boolean;
  sampleRate: number;
  stale: () => boolean;
  onCues: (lines: LyricsLine[], source: LyricsSource) => void;
  onStatus?: (msg: string | null) => void;
}

/**
 * Resolve a deck's lyrics.
 *   0) the best transcript already on hand — local cache, else the community pool (version-gated).
 *   1) LRCLIB: the words, and a line clock. SHOWN IMMEDIATELY — this alone is a working feature.
 *   2) the vocal stem, if this device has one: fix the whole-track offset and place every WORD.
 *   3) YouTube captions, if LRCLIB has never heard of the track.
 */
export async function resolveLyrics(o: ResolveOpts): Promise<void> {
  if (o.engine === "youtube") {
    if (o.force) await clearLyricsCache(o.videoId);
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

  if (o.force) await clearLyricsCache(o.videoId);

  // 0) Already have it?
  let local: { lines: LyricsLine[]; ver: number; source: LyricsSource } | null = null;
  let pooled: LyricsTranscript | null = null;
  if (!o.force) {
    local = await cachedLocal(o.videoId);
    if (o.stale()) return;
    if (!local || local.ver < LYRICS_VER) {
      pooled = await poolGet(o.videoId);
      if (o.stale()) return;
    }
  }
  const plan = planLyrics({
    local: local?.ver ?? null,
    pooled: pooled?.lines?.length ? (pooled.ver ?? 1) : null,
    clientVer: LYRICS_VER,
    canDecode: o.enabled,
  });

  let best: { lines: LyricsLine[]; source: LyricsSource } | null = null;
  if (plan.show === "pool" && pooled?.lines?.length) {
    best = { lines: pooled.lines, source: "pool" };
    mem.set(o.videoId, pooled.lines);
    memSource.set(o.videoId, "pool");
    if (plan.adoptPool) {
      void putLyricsLocal(o.videoId, { lines: pooled.lines, model: pooled.model, ver: pooled.ver ?? 1 });
    }
  } else if (plan.show === "local" && local) {
    best = { lines: local.lines, source: local.source };
  }
  if (best) {
    o.onCues(best.lines, best.source);
    o.onStatus?.(null);
    if (!plan.decode) return;
  }
  if (!plan.decode) return; // lyrics off

  // Single-flight per track: both decks on the same song do this once.
  const waiter: Waiter = { deck: o.deck, stale: o.stale, stemsEnabled: o.stemsEnabled !== false };
  const set = waiters.get(o.videoId) ?? new Set<Waiter>();
  set.add(waiter);
  waiters.set(o.videoId, set);

  let job = inflight.get(o.videoId);
  if (!job) {
    const bornAt = genOf(o.videoId);
    job = (async (): Promise<LyricsLine[] | null> => {
      const t0 = Date.now();
      // The deck may not have decoded yet — trust the catalog's length, and only fall back to the
      // deck (which is 0 this early in a load).
      const duration = o.duration || o.deck.duration || 0;
      const diag: LyricsDiag = {
        source: "lrclib",
        artist: null,
        title: null,
        matched: false,
        instrumental: false,
        lines: 0,
        words: 0,
        onsets: 0,
        offset: 0,
        confidence: 0,
        voiced: 0,
        bias: 0,
        drift: 0,
        snapped: 0,
        free: 0,
        applied: false,
        ms: 0,
      };
      const finish = <T,>(v: T): T => {
        diag.ms = Date.now() - t0;
        diags.set(o.videoId, diag);
        return v;
      };

      // 1) WHO is this? (the recommender's fingerprint chain, reused)
      o.onStatus?.("lyrics — identifying…");
      const name = await canonicalName(o.videoId, o.trackTitle);
      if (o.stale() && !set.size) return finish(null);
      if (!name) return finish(null); // no name → no lookup possible
      diag.artist = name.artist;
      diag.title = name.title;

      // 2) WHAT was sung? (ground truth, not a guess)
      o.onStatus?.("lyrics — looking up…");
      const lrc = await bounded(
        (signal) => fetchLrcLib({ ...name, duration }, signal),
        null,
        () => (diag.lookupFailed = true),
      );
      if (!lrc) return finish(null);
      diag.matched = true;
      if (lrc.instrumental) {
        // LRCLIB knows this recording has no vocals. A free, CORRECT "no lyrics" — where Whisper
        // used to hallucinate a verse over a techno track.
        diag.instrumental = true;
        return finish([]);
      }
      // ★ PLAIN LYRICS ARE NOT A MISS. About 1 song in 16 has the right words on LRCLIB and no line
      // clock at all — and having no clock is not a missing input, it is the ORDINARY case forced
      // alignment was invented for. We know the words and their order; the vocal stem tells us where
      // they land. It needs the stem, though (there is nothing else to go on), so it is not shown
      // until we have one.
      diag.plainOnly = !lrc.synced?.length;
      const lines = lrc.synced?.length ? lrcToLines(lrc.synced, duration) : [];
      diag.lines = lines.length || (lrc.plain?.length ?? 0);
      if (!lines.length && !lrc.plain?.length) return finish(null);
      // ★ FROM HERE ON, WE KNOW THE REAL WORDS — SO YOUTUBE IS NEVER THE ANSWER AGAIN. Its caption
      // track for a German industrial single turned out to be nonsense in FRENCH. Falling back to it
      // when a lyrics database has already handed us the correct words is not a graceful degradation,
      // it is replacing truth with garbage. Say what's missing (the timing) instead of lying about
      // what we have (the words).
      diag.matched = true;

      // Show them NOW, at LRCLIB's own clock. This is already a working feature: no stem, no model,
      // no GPU, works on a phone. Everything below is an UPGRADE, not a prerequisite.
      if (lines.length && !o.stale()) {
        o.onCues(lines, "lrclib");
        o.onStatus?.(null);
      }

      // 3) WHEN was it sung? Only if this device actually has an isolated vocal to measure.
      const vocals = await waitForNeuralVocals(o.videoId, o.onStatus);
      if (!vocals) {
        if (!lines.length) {
          // We hold the right words and there is no clock anywhere: LRCLIB never timed them, and
          // there's no vocal stem to measure. Say exactly that, and show nothing — the words are
          // real and one setting away from being usable. YouTube's captions are NOT the fallback
          // here (see above): a wrong-language auto-caption is worse than an honest blank.
          o.onStatus?.("Lyrics found — turn on stem separation to time them");
          return finish([]);
        }
        o.onStatus?.(null);
        diag.source = "lrclib";
        mem.set(o.videoId, lines);
        memSource.set(o.videoId, "lrclib");
        void putLyricsLocal(o.videoId, { lines, model: "lrclib", ver: LYRICS_VER });
        return finish(lines); // line-level. Good enough to sing along to; not pooled (not our best).
      }
      o.onStatus?.("lyrics — aligning to the vocal…");
      const aligned = await alignOnWorker(
        vocals,
        o.sampleRate,
        lines.length ? { lines } : { plain: lrc.plain ?? [] },
        duration,
        (_p, pct) => o.onStatus?.(`lyrics — aligning ${pct}%`),
      );
      if (genOf(o.videoId) !== bornAt) return finish(null); // superseded by a forced reprocess
      if (!aligned.lines.length) return finish(null);

      diag.source = lines.length ? "aligned" : "estimated";
      diag.onsets = aligned.onsets;
      diag.words = aligned.report.words;
      diag.offset = aligned.report.offset;
      diag.confidence = aligned.report.confidence;
      diag.voiced = aligned.report.voiced;
      diag.bias = aligned.report.bias;
      diag.drift = aligned.report.drift;
      diag.snapped = aligned.report.snapped;
      diag.free = aligned.report.free;
      diag.applied = aligned.report.applied;

      mem.set(o.videoId, aligned.lines);
      memSource.set(o.videoId, diag.source);
      void putLyricsLocal(o.videoId, { lines: aligned.lines, model: diag.source, ver: LYRICS_VER });
      // Contribute. No degeneracy check is needed any more: the WORDS are ground truth, so the worst
      // this can be is mistimed — never fiction. That guard existed only because Whisper could lie.
      void poolPut({
        v: 1,
        videoId: o.videoId,
        model: diag.source,
        lang: "und",
        source: diag.source,
        conf: aligned.report.confidence,
        ver: LYRICS_VER,
        lines: aligned.lines,
        createdAt: Date.now(),
      });
      return finish(aligned.lines);
    })();
    inflight.set(o.videoId, job);
    const created = job;
    void created.finally(() => {
      if (inflight.get(o.videoId) === created) inflight.delete(o.videoId);
    });
  }

  try {
    const lines = await job.finally(() => {
      const s = waiters.get(o.videoId);
      if (s) {
        s.delete(waiter);
        if (!s.size) waiters.delete(o.videoId);
      }
    });
    if (o.stale()) return;
    if (lines?.length) {
      o.onCues(lines, diags.get(o.videoId)?.source ?? "aligned");
      o.onStatus?.(null);
      return;
    }
    if (lines && !lines.length) {
      // Either a known instrumental, or the right words with no clock to put them on. Both are
      // ANSWERS, not failures — and neither is improved by going fishing in YouTube's captions.
      // The status was set by the branch that knows which; leave it up.
      const d = diags.get(o.videoId);
      if (d?.instrumental) {
        o.onStatus?.("Instrumental — no lyrics");
        setTimeout(() => !o.stale() && o.onStatus?.(null), 5000);
      }
      return;
    }
  } catch (err) {
    console.warn("[htl] lyrics failed:", err);
  }

  // 4) Nothing was shown and the job produced nothing. Before YouTube: the POOL. A force wipes the
  // local copy and skips both cache reads, so when the re-derive then dies on a transient (an LRCLIB
  // timeout is `lookupFailed`, not a miss — see `bounded`), this resolve is holding NOTHING even
  // though a perfectly good transcript may still be sitting in the pool. That is exactly how a deck
  // that HAD real lyrics downgraded itself to YouTube captions live: reprocess → lookup failed →
  // "never heard of it" branch. A pooled transcript is PROOF the track has lyrics; recover it, say
  // the lookup failed, and never let a timeout be reported as a miss.
  if (best) {
    // We already showed something — but the job died with a status pill still up ("lyrics —
    // looking up…" pinned FOREVER was a live symptom: LRCLIB answers in 7-10s and sometimes not at
    // all, and this path used to return without touching the status). Say what happened, briefly,
    // and leave the shown transcript alone.
    if (diags.get(o.videoId)?.lookupFailed) {
      o.onStatus?.("Lyrics lookup failed — keeping the current copy");
      setTimeout(() => !o.stale() && o.onStatus?.(null), 5000);
    } else {
      o.onStatus?.(null);
    }
    return;
  }
  const recovered = await poolGet(o.videoId);
  if (o.stale()) return;
  if (recovered?.lines?.length) {
    mem.set(o.videoId, recovered.lines);
    memSource.set(o.videoId, "pool");
    o.onCues(recovered.lines, "pool");
    if (diags.get(o.videoId)?.lookupFailed) {
      o.onStatus?.("Lyrics lookup failed — showing the shared copy");
      setTimeout(() => !o.stale() && o.onStatus?.(null), 5000);
    } else {
      o.onStatus?.(null);
    }
    return;
  }
  // LRCLIB has genuinely never heard of this track → YouTube's captions, warts and all.
  const cues = await bounded(() => fetchCaptions(o.videoId), []);
  if (o.stale()) return;
  if (cues.length) {
    o.onCues(cues, "youtube");
    o.onStatus?.(null);
  } else {
    o.onStatus?.("No lyrics found");
    setTimeout(() => !o.stale() && o.onStatus?.(null), 5000);
  }
}
