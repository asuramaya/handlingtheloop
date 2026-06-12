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
  // Pro-Q-style movable band frequencies (Hz) + mid bell width. Optional so old
  // snapshots load fine — the deck falls back to the default fixed positions.
  eqLowFreq?: number;
  eqMidFreq?: number;
  eqHighFreq?: number;
  eqMidQ?: number;
  eqHpFreq?: number; // low-cut cutoff (Hz)
  eqHpQ?: number;
  eqLpFreq?: number; // high-cut cutoff (Hz)
  eqLpQ?: number;
  eqBypass?: boolean; // EQ out of circuit
  filter: number; // -1..1 color filter
  fxOn?: boolean; // FX master (filter) enabled
  keylock: boolean;
  pitchSemis?: number; // musical key shift in semitones
  quantize: boolean;
  skipBeats?: number; // per-deck jog skip resolution (beats)
  cuePoint: number;
  hotCues: (number | null)[];
  hotLoops: (LoopSnapshot | null)[];
  loop: LoopSnapshot | null;
  loopInPoint: number | null;
  position: number;
  playing: boolean;
  // Per-stem mixer state (keyed by stem name). Part of the session so a reload /
  // a co-DJ joining restores which stems are muted and at what level.
  stemGains?: Record<string, number>; // 0–1.5, 1 = unity
  stemMutes?: Record<string, boolean>;
}

export interface SessionSnapshot {
  decks: { A: DeckSnapshot; B: DeckSnapshot };
  crossfade: number;
  zoom: { A: number; B: number }; // per-deck waveform zoom (real seconds shown)
  tempoRange?: number; // global tempo-fader range (±%) — scales the fader, so it's session state
}

const store = new Store<SessionSnapshot | null>("session", null, 1);

export function loadSession(): SessionSnapshot | null {
  const s = store.get();
  if (!s) return null;
  // Migrate the old shared single zoom (a number) to the per-deck shape.
  if (typeof (s.zoom as unknown) === "number") {
    const z = s.zoom as unknown as number;
    s.zoom = { A: z, B: z };
  }
  return s;
}

export function saveSession(s: SessionSnapshot): void {
  store.set(s);
}

export function clearSession(): void {
  store.clear();
}
