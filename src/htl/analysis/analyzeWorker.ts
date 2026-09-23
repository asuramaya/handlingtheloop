// Client side of the analysis worker: post an AudioBuffer's channels, await the
// TrackAnalysis. Degrades gracefully — if the worker can't be constructed or dies
// mid-flight, analysis runs inline on the main thread so a track still loads.
import { analyzeChannels } from "./analyze";
import type { Beatgrid, TrackAnalysis } from "./analyze";

let worker: Worker | null = null;
let failed = false; // construction failed once → don't keep retrying, go inline
let seq = 0;

// ★ A SILENTLY DEGRADED WORKER LOOKS EXACTLY LIKE A WORKING ONE. Every fallback here is correct and
// invisible: the track still loads, the analysis is still right, and the only difference is that the
// whole detector just ran on the MAIN THREAD — which is the entire thing this module exists to
// avoid. "Seems fine" is then unfalsifiable, and the symptom (a long frame at track load) surfaces
// nowhere near the cause.
//
// So each distinct reason says itself ONCE per session. Once, because this runs per track load and a
// line per load is noise nobody reads; distinct, because "could not construct" and "threw mid-flight"
// have different causes and different fixes. Metron's bc201e32 requires the same of the stems worker
// before anyone may believe a green run from it; this is the live instance of that class, in the
// worker that already exists.
// ★ AND THE THIRD SHAPE, WHICH IS THE ONE THAT DOES NOT ANNOUNCE ITSELF. Construction failing and
// `onerror` firing are failures that TELL you. A worker that accepts the message and never replies
// does not: no error, no rejection, and the pending entry sits in the map forever. App.tsx awaits
// this on the track-load critical path — setBuffer, the deck's grid and key, setLoaded are all
// after it — so a silent worker is not a slow load, it is a deck that NEVER LANDS, with the
// loadingVid claim still held. The realistic trigger is a browser reclaiming a worker under memory
// pressure, which is the iOS case this repo's stem-paging history is entirely about.
//
// ★ WHY THIS RECOVERS RATHER THAN ONLY REPORTING. Metron proposed noticing without recovering, on
// the sound argument that a timeout which acts has a tradeoff and one that only watches has none.
// The reason to go further here is that the recovery is NOT a new mechanism: it is the same
// `inline()` the other two failure modes already take, it always works, and the repo has already
// ruled twice that a load which goes silent must FAIL rather than hang (3ea664e, 23f5367). The
// asymmetry decides it — today the deck never lands at all; with a budget the worst case is a long
// wait and then a correct load.
//
// The budget is deliberately generous, derived rather than picked: a full analyzeTrack measures
// ~1.4 s for a five-minute track on this desktop, so ~5.5 s on a phone at 4x. 30 s is five times
// that, which is slow enough that nothing legitimate is cut off and short enough that a dead worker
// stops costing a deck. A late reply after the budget is already harmless — onmessage drops any id
// it no longer holds.
const WORKER_BUDGET_MS = 30_000;

// ★ ONE FLAG WAS CARRYING TWO CAUSES WITH DIFFERENT CORRECT LIFETIMES. `failed` retires the worker
// for the session, which is RIGHT for a construction failure — an environment with no usable Worker
// will not grow one — and wrong for a hang. The trigger named above is a browser reclaiming a worker
// under memory pressure, and that is TRANSIENT by nature: a backgrounded phone reclaims, comes back,
// and would construct one fine. Retiring permanently converts one reclamation into a session-long
// main-thread regression, on the platform least able to afford it, while the witness — correctly
// saying itself once — stays quiet through every load after.
//
// So a hang buys exactly ONE reconstruction. The worst case is paying the budget a second time,
// once; after that it really is retired. (Found by Metron, and it is the inverse of the distinction
// one level down: the witness separates per-CAUSE, and this flag was merging two causes.)
const HANG_RETRIES = 1;

// ★ AND THE COUNTER COUNTED VICTIMS, NOT INCIDENTS. Requests overlap here as a matter of course —
// usePrefetch can have an analysis in flight when a user load starts, and two decks load
// independently — and every request arms its OWN clock. One reclaimed worker therefore strands ALL
// of them, each timer fires, and each one was incrementing `hangs`. Two overlapping loads made a
// single reclamation retire the worker permanently on the spot, which is precisely the case the
// retry above exists for: memory pressure on a phone, where a prefetch and a user load overlapping
// is the normal shape rather than the unlucky one.
//
// So a hang is attributed to a worker GENERATION, which ENDS when the first victim retires it. That
// victim counts the incident; every other request still waiting on the dead generation falls back
// inline and counts nothing, because it is the same silence heard again, not a second failure.
//
// `gen` IS the incident count — a generation ends only by being retired by a hang — so there is one
// counter here rather than two that have to stay in lockstep. A request's own `myGen` therefore also
// says which incident stranded it, which is what lets its message describe THAT incident instead of
// reading whatever the shared state has since become (Metron, on the first version).
let gen = 0;

const told = new Set<string>();
function fellBack(why: string): void {
  if (told.has(why)) return;
  told.add(why);
  console.info(`[htl] analysis worker unavailable (${why}) — analysing on the MAIN THREAD instead; expect a long frame at track load`);
}
type Pending = { resolve: (a: TrackAnalysis) => void; reject: (e: unknown) => void };
const pending = new Map<number, Pending>();

function getWorker(): Worker | null {
  if (worker || failed) return worker;
  try {
    worker = new Worker(new URL("./analysis.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<{ id: number; analysis?: TrackAnalysis; error?: string }>) => {
      const { id, analysis, error } = e.data;
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      if (error || !analysis) p.reject(new Error(error ?? "analysis failed"));
      else p.resolve(analysis);
    };
    worker.onerror = () => {
      // Reject everything in flight; each call's .catch falls back inline. The worker is NOT retired
      // here, and that is measured rather than assumed: Metron probed this repo's own Chromium and a
      // Worker that throws an uncaught error fires onerror, drops that one message, and answers the
      // very next one normally. Retiring it would throw away a healthy worker. (A worklet is the
      // opposite — see workletWatch.ts — which is why the same word for both is a trap.)
      for (const [id, p] of pending) {
        pending.delete(id);
        p.reject(new Error("analysis worker error"));
      }
    };
    return worker;
  } catch {
    failed = true;
    worker = null;
    fellBack("could not be constructed");
    return null;
  }
}

/** Analyse `buffer` off-thread. A MONO MIX is copied before transfer, so the live playback buffer is
 *  never detached. When `grid` is passed (a grid reused from the crowdsourced cache), beat detection
 *  is skipped and that grid is used verbatim — key and the LOD pyramid are still derived from the
 *  buffer off-thread (they aren't persisted).
 *
 *  ★ IT USED TO SEND BOTH CHANNELS, AND NOTHING ON THE OTHER SIDE WANTED THEM. All three consumers
 *  downmix first and with the identical expression — computePyramidFromChannels, the key chromagram
 *  and beats.ts's decimateMono each compute `(ch0[i] + ch1[i]) * 0.5`. So the second channel crossed
 *  the boundary only to be averaged away three times. Doing it here instead is one pass rather than
 *  two copies, and it halves both the allocation and the transfer: measured on a 4-minute stereo
 *  track at 48k, 88 MB / 47 ms became 44 MB / 37 ms. The memory is the half that matters — that peak
 *  lands on a phone in the middle of a track load.
 *
 *  Measured identical, not merely close: same bpm, same 511 beats to under a microsecond, same key,
 *  same downbeat, same energy. (Pre-mixing stores the average as float32 where the consumers held it
 *  as a double, so the two are not identical BY CONSTRUCTION — they were identical in fact on real
 *  material, and that is the claim.)
 *
 *  ★ AND THE INLINE PATH COPIES NOTHING AT ALL NOW. The copy exists to survive a TRANSFER; when
 *  there is no worker there is no transfer and nothing can be detached, so the fallback reads the
 *  live channels directly. That path is the one that runs on the devices least able to afford the
 *  allocation — the ones where constructing a Worker failed. */
export function analyzeTrackAsync(buffer: AudioBuffer, grid?: Beatgrid | null): Promise<TrackAnalysis> {
  const sampleRate = buffer.sampleRate;
  // No transfer, no detach → read the live buffer, copy nothing.
  const inline = (): TrackAnalysis =>
    analyzeChannels(
      buffer.getChannelData(0),
      buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : null,
      sampleRate,
      grid,
    );

  const w = getWorker();
  // No second line here: getWorker only returns null once construction has already failed, which
  // already said so. A distinct reason per SITE rather than per CAUSE is how one condition starts
  // reporting itself twice.
  if (!w) return Promise.resolve(inline());
  const myGen = gen; // which worker this request is waiting on — see the note on `gen`

  const l = buffer.getChannelData(0);
  const r = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : null;
  const mono = new Float32Array(l.length);
  if (r) for (let i = 0; i < l.length; i++) mono[i] = (l[i] + r[i]) * 0.5;
  else mono.set(l);
  const id = ++seq;
  return new Promise<TrackAnalysis>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    // Silence is the failure mode with no event, so it needs a clock of its own.
    setTimeout(() => {
      if (!pending.has(id)) return; // answered in time
      pending.delete(id);
      // Only the first victim of an incident retires the generation; a later one is the same
      // silence heard again, and counting it would spend the retry on one reclamation.
      if (myGen === gen) {
        gen++; // this generation is over — its other stranded requests must not count themselves
        failed = gen > HANG_RETRIES; // a first hang may be a reclamation; a second is a broken worker
        try {
          worker?.terminate();
        } catch {
          /* already gone */
        }
        worker = null;
      }
      // Derived from this request's OWN generation, not from module state: a victim stranded by the
      // first incident whose timer lands after a second one must still report the first.
      reject(new Error(myGen + 1 > HANG_RETRIES ? "analysis worker stopped answering twice" : "analysis worker stopped answering"));
    }, WORKER_BUDGET_MS);
    // Only the mix transfers — `grid` is small and structured-cloned (its Float32Arrays stay owned
    // by the caller, which needs the grid intact for its own use).
    w.postMessage({ id, ch0: mono, ch1: null, sampleRate, grid }, [mono.buffer]);
  }).catch((e: unknown) => {
    const m = String((e as Error)?.message);
    // Distinct facts for a reader: the first hang will be retried, the second will not.
    fellBack(
      m.includes("twice")
        ? "stopped answering twice — staying on the main thread for this session"
        : m.includes("stopped answering")
          ? "stopped answering — will try once more on the next load"
          : "threw mid-flight — it survives and answers the next load, this one fell back",
    );
    return inline(); // re-read the intact source buffer
  });
}
