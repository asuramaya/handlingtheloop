import type { TrackAnalysis } from "../analysis/analyze";

// Session cache of decoded audio + analysis, keyed by videoId. Loading the same
// track to a deck again (e.g. the other deck, or a re-cue) is then instant — no
// re-download, no re-decode, no re-analysis. Buffers belong to the single
// AudioEngine context, so they're safe to share across decks.

export interface CachedTrack {
  buffer: AudioBuffer;
  analysis: TrackAnalysis;
}

const cache = new Map<string, CachedTrack>();

export function getCachedTrack(videoId: string): CachedTrack | undefined {
  return cache.get(videoId);
}

export function setCachedTrack(videoId: string, value: CachedTrack): void {
  cache.set(videoId, value);
}
