// Timestamped captions for a loaded video — fetched from the SAME player response
// the audio resolves through, so when a stream lands its captions land too. Many
// videos (esp. music) have none → an empty array, which the UI simply hides.
export interface CaptionCue {
  start: number; // seconds
  end: number;
  text: string;
}

// Per-session cache — captions are stable per video and small. We cache only
// SUCCESSES (non-empty): an empty result is the same shape whether the track truly
// has no captions or the IP/session-bound timedtext endpoint just flaked, and we
// don't want one flake to blacklist a track for the whole session (that was the
// "deck A has no chin" bug — A raced/flaked, cached [], and never retried).
const cache = new Map<string, CaptionCue[]>();
// Coalesce concurrent calls for the same video (both decks loading the same track)
// onto ONE request, so one can't land while the other flakes.
const inflight = new Map<string, Promise<CaptionCue[]>>();

export function fetchCaptions(videoId: string): Promise<CaptionCue[]> {
  const hit = cache.get(videoId);
  if (hit) return Promise.resolve(hit);
  const pending = inflight.get(videoId);
  if (pending) return pending;
  const p = (async () => {
    try {
      const res = await fetch(`/api/captions?v=${encodeURIComponent(videoId)}`);
      if (!res.ok) return [];
      const { cues } = (await res.json()) as { cues?: CaptionCue[] };
      const out = Array.isArray(cues) ? cues : [];
      if (out.length) cache.set(videoId, out); // only memoize hits — let empties retry
      return out;
    } catch {
      return [];
    } finally {
      inflight.delete(videoId);
    }
  })();
  inflight.set(videoId, p);
  return p;
}
