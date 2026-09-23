import { decodeStemOpusPlanes, planesToBuffer } from "./opus";

// Client side of the stem-decode worker (task #132), built on the patterns the ANALYSIS worker had
// to learn the hard way rather than re-learning them here.
//
// ★ OBLIGATION bc201e32 IS THE REASON THE WITNESS COMES FIRST. "The stems decode Worker must land
// with an observability line BEFORE it is trusted — its degrade-to-inline fallback makes a silently
// degraded worker look exactly like success." That is not hypothetical: every fallback below is
// correct and invisible. The stems still decode, they are still right, and the only difference is
// that the whole decode just ran on the MAIN THREAD, which is the entire thing this module exists
// to avoid. A green stemlab run means nothing unless it can say which path it took.
//
// So: each distinct reason says itself ONCE per session (a line per stem load is noise nobody
// reads; distinct because "could not construct" and "threw mid-flight" have different fixes), and
// `lastPath` reports what actually happened for a harness to assert on rather than infer.
//
// ★ AND A HANG IS ATTRIBUTED TO A WORKER GENERATION, not counted per victim. Four stems decode per
// song load and they overlap by construction, so one reclaimed worker strands all four; counting
// each of them would spend the whole retry budget on a single incident. That defect is not a guess
// — it shipped in analyzeWorker and Metron found it there.
//
// Budget: a 4-minute stem decodes in ~1.5 s here and ~6 s on a phone at 4x. 30 s is five times that
// — long enough that nothing legitimate is cut off, short enough that a dead worker stops costing a
// song load.
const WORKER_BUDGET_MS = 30_000;
const HANG_RETRIES = 1;

let worker: Worker | null = null;
let failed = false;
let seq = 0;
let gen = 0;

export type DecodePath = "worker" | "inline";
let lastPath: DecodePath | null = null;
/** What the LAST decode actually did. bc201e32: a green run is not believable without this. */
export function lastDecodePath(): DecodePath | null {
  return lastPath;
}
/** Tests only — module state is shared within a vitest worker. */
export function resetStemDecodeWitness(): void {
  lastPath = null;
  told.clear();
}

const told = new Set<string>();
function fellBack(why: string): void {
  if (told.has(why)) return;
  told.add(why);
  console.info(`[htl] stem decode worker unavailable (${why}) — decoding on the MAIN THREAD instead; expect a long frame at song load`);
}

type Pending = { resolve: (v: { planes: Float32Array[]; sampleRate: number }) => void; reject: (e: unknown) => void };
const pending = new Map<number, Pending>();

function getWorker(): Worker | null {
  if (worker || failed) return worker;
  try {
    worker = new Worker(new URL("./opus.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<{ id: number; planes?: Float32Array[]; sampleRate?: number; error?: string }>) => {
      const { id, planes, sampleRate, error } = e.data;
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      if (error || !planes || sampleRate == null) p.reject(new Error(error ?? "stem decode failed"));
      else p.resolve({ planes, sampleRate });
    };
    worker.onerror = () => {
      // A Worker SURVIVES an uncaught error — measured in this repo's own Chromium: it fires
      // onerror, drops that one message, and answers the next normally. So reject what is in
      // flight and keep it.
      for (const [id, p] of pending) {
        pending.delete(id);
        p.reject(new Error("stem decode worker error"));
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

/** Decode an htl-Opus blob to planes, off the main thread when possible. Never throws for a
 *  worker-side reason: every failure falls back to decoding inline, and says so once. */
export async function decodeStemPlanesAsync(bytes: ArrayBuffer): Promise<{ planes: Float32Array[]; sampleRate: number }> {
  const inline = async () => {
    lastPath = "inline";
    return decodeStemOpusPlanes(bytes);
  };
  const w = getWorker();
  if (!w) return inline();
  const myGen = gen;
  const id = ++seq;
  // The blob is TRANSFERRED, so the caller's copy is detached — the inline fallback needs its own.
  const forInline = bytes.slice(0);
  return new Promise<{ planes: Float32Array[]; sampleRate: number }>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (!pending.has(id)) return;
      pending.delete(id);
      if (myGen === gen) {
        gen++;
        failed = gen > HANG_RETRIES;
        try {
          worker?.terminate();
        } catch {
          /* already gone */
        }
        worker = null;
      }
      reject(new Error(myGen + 1 > HANG_RETRIES ? "stopped answering twice" : "stopped answering"));
    }, WORKER_BUDGET_MS);
    w.postMessage({ id, bytes }, [bytes]);
  })
    .then((r) => {
      lastPath = "worker";
      return r;
    })
    .catch((e: unknown) => {
      const m = String((e as Error)?.message);
      fellBack(
        m.includes("twice")
          ? "stopped answering twice — staying on the main thread for this session"
          : m.includes("stopped answering")
            ? "stopped answering — will try once more on the next load"
            : "threw mid-flight — it survives and answers the next load, this one fell back",
      );
      lastPath = "inline";
      return decodeStemOpusPlanes(forInline);
    });
}

/** The app's stem-decode entry: off the main thread when possible, assembled here because an
 *  AudioContext cannot exist in a worker. opus.ts deliberately does NOT import this module — the
 *  worker imports opus.ts, so a dependency the other way would be a cycle and would drag a Worker
 *  constructor into the worker's own bundle. The direction is: index → opusWorker → opus. */
export async function decodeStemOpusOffThread(ctx: BaseAudioContext, bytes: ArrayBuffer): Promise<AudioBuffer> {
  const { planes, sampleRate } = await decodeStemPlanesAsync(bytes);
  return planesToBuffer(ctx, planes, sampleRate);
}
