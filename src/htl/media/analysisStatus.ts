import { fetchAnalysisRows } from "./api";

// THE ONE CLIENT-SIDE POOL over the shared `track_analysis` dataset (the crowdsourced BPM/key lane).
// Two consumers read through it: list rows (Library / Search badges, via primeAnalysis) and the
// auto-mix queue (candidate scoring, via lookupAnalysis). They used to be two paths. The rows had a
// pool; the queue called the endpoint raw on every fill with no memory, so a candidate with no row
// was re-asked forever, and a row the list had already fetched was fetched again.
//
// What is remembered, and for how long, is the design:
//   • A HIT is kept for the session. A row is a fact about the recording; it does not un-happen.
//   • A MISS expires after MISS_TTL_MS. The dataset GROWS (any device that plays a track posts its
//     analysis), so a track with no row now can have one later. Remembering a miss forever pins it
//     blank; forgetting it at once is the re-ask-every-fill defect.
//   • A FAILED REQUEST records nothing. An outage is not evidence that a track has no row, and
//     recording it as one would blank a whole list for the TTL.
//   • Concurrent asks for the same id share one request.

export interface RowAnalysis {
  bpm: number | null;
  key: string | null;
  energy?: number | null;
}

export const MISS_TTL_MS = 10 * 60_000;
const CHUNK = 100; // the server caps an ?ids= list at 100 (server/db/analysis.ts getAnalysisByIds)
const FLUSH_MS = 120; // primeAnalysis: coalesce a burst of mounting rows into one request
const VIDEO_ID = /^[\w-]{11}$/;

const known = new Map<string, RowAnalysis>(); // hits
const missedAt = new Map<string, number>(); // misses → when observed
const inflight = new Map<string, Promise<void>>(); // id → the request currently answering it
const subscribers = new Set<() => void>();
let pending = new Set<string>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function answered(id: string): boolean {
  if (known.has(id) || inflight.has(id)) return true;
  const at = missedAt.get(id);
  return at !== undefined && Date.now() - at < MISS_TTL_MS;
}

function emit() {
  subscribers.forEach((fn) => fn());
}

function start(ids: string[]): void {
  const run = (async () => {
    for (let i = 0; i < ids.length; i += CHUNK) {
      const slice = ids.slice(i, i + CHUNK);
      const rows = await fetchAnalysisRows(slice);
      const at = Date.now();
      for (const id of slice) {
        const a = rows[id];
        if (a) {
          known.set(id, a);
          missedAt.delete(id);
        } else {
          missedAt.set(id, at);
        }
      }
    }
  })().catch(() => {
    /* a failure records nothing, so the next ask re-fetches */
  });
  const done: Promise<void> = run.then(() => {
    for (const id of ids) if (inflight.get(id) === done) inflight.delete(id);
    emit();
  });
  for (const id of ids) inflight.set(id, done);
}

/** Pooled analysis for one track, or null when no row is known (unfetched, a miss, or a failure). */
export function analysisState(videoId: string): RowAnalysis | null {
  return known.get(videoId) ?? null;
}

export function subscribeAnalysis(fn: () => void): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}

/** Resolve analysis through the pool: known hits return without a request, only unanswered ids are
 *  fetched, in-flight ones are awaited. The result holds HITS only. Never throws. */
export async function lookupAnalysis(videoIds: string[]): Promise<Record<string, RowAnalysis>> {
  const ids = Array.from(new Set(videoIds.filter((id) => VIDEO_ID.test(id))));
  const ask = ids.filter((id) => !answered(id));
  if (ask.length) start(ask);
  await Promise.all(ids.map((id) => inflight.get(id)).filter((p): p is Promise<void> => !!p));
  const out: Record<string, RowAnalysis> = {};
  for (const id of ids) {
    const a = known.get(id);
    if (a) out[id] = a;
  }
  return out;
}

/** Fire-and-forget priming for list rows: coalesces a burst of ids into one pooled lookup. */
export function primeAnalysis(videoIds: string[]): void {
  for (const id of videoIds) if (id && VIDEO_ID.test(id) && !answered(id)) pending.add(id);
  if (pending.size && flushTimer == null) {
    flushTimer = setTimeout(() => {
      flushTimer = null;
      const batch = Array.from(pending);
      pending = new Set();
      void lookupAnalysis(batch);
    }, FLUSH_MS);
  }
}
