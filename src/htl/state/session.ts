// Performance session that survives a refresh: which track is on each deck, the
// per-deck control state, and the global mixer/zoom. Audio bytes live in the
// IndexedDB audioCache (keyed by the same videoId), so a reload re-hydrates the
// decks without re-downloading. Pure data + a Store — the app builds snapshots
// from the engine and applies them back, so this module stays audio-agnostic.
import { Store } from "../persistence";

export interface LoopSnapshot {
  active: boolean;
  start: number;
  end: number;
  beats: number;
}

export interface DeckSnapshot {
  videoId: string | null;
  name: string;
  artist: string;
  bpm: number | null;
  duration: number;
  tempo: number;
  trim: number; // linear gain
  level: number; // linear gain
  eqLow: number; // dB
  eqMid: number;
  eqHigh: number;
  filter: number; // -1..1 color filter
  keylock: boolean;
  quantize: boolean;
  cuePoint: number;
  hotCues: (number | null)[];
  hotLoops: (LoopSnapshot | null)[];
  loop: LoopSnapshot | null;
  loopInPoint: number | null;
  position: number;
  playing: boolean;
}

export interface SessionSnapshot {
  decks: { A: DeckSnapshot; B: DeckSnapshot };
  crossfade: number;
  zoom: number;
}

const store = new Store<SessionSnapshot | null>("session", null, 1);

export function loadSession(): SessionSnapshot | null {
  return store.get();
}

export function saveSession(s: SessionSnapshot): void {
  store.set(s);
}

export function clearSession(): void {
  store.clear();
}
